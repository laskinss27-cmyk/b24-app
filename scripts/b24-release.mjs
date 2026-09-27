import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sourceRoots, isSourcePath, sha256, sourceHash, validSha, compareFiles } from './b24-release-integrity.mjs';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 100 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr || result.stdout || result.status}`);
  return result.stdout;
}

export function gitManifest(cwd, ref, { normalizeEol = false } = {}) {
  const gitSha = run('git', ['rev-parse', `${ref}^{commit}`], { cwd }).trim();
  const gitTree = run('git', ['rev-parse', `${ref}^{tree}`], { cwd }).trim();
  const names = run('git', ['ls-tree', '-r', '--name-only', '-z', gitSha, '--', ...sourceRoots], { cwd })
    .split('\0').filter((name) => name && isSourcePath(name));
  const blobs = run('git', ['cat-file', '--batch'], { cwd, encoding: null, input: names.map((name) => `${gitSha}:${name}\n`).join('') });
  const files = {};
  let offset = 0;
  for (const name of names) {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isSafeInteger(size)) throw new Error(`Invalid Git blob: ${name}`);
    offset = end + 1;
    files[name] = sourceHash(blobs.subarray(offset, offset + size), normalizeEol);
    offset += size + 1;
  }
  if (!validSha(gitSha) || !validSha(gitTree) || !files['package-lock.json']) throw new Error('Incomplete Git release');
  return { schema: 1, gitSha, gitTree, files };
}

export function cleanHead(cwd, expectedSha) {
  if (run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd }).trim()) {
    throw new Error('Release blocked: commit or remove all modified/staged/untracked files first');
  }
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd }).trim();
  if (expectedSha && (!validSha(expectedSha) || expectedSha !== sha)) throw new Error('Expected full SHA must equal clean checkout HEAD');
  const branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }).trim();
  const remote = run('git', ['config', '--get', `branch.${branch}.remote`], { cwd }).trim();
  const ref = run('git', ['config', '--get', `branch.${branch}.merge`], { cwd }).trim();
  if (!remote || remote === '.' || !ref.startsWith('refs/heads/')) throw new Error('Release requires a published upstream branch');
  const published = run('git', ['ls-remote', '--exit-code', remote, ref], { cwd }).trim().split(/\s+/)[0];
  if (published !== sha) throw new Error('Release blocked: HEAD is not the current pushed upstream commit');
  return sha;
}

export function prepare(cwd, output) {
  const sha = cleanHead(cwd);
  const manifest = gitManifest(cwd, sha);
  const context = resolve(output);
  if (existsSync(context)) throw new Error('Output directory must not exist');
  mkdirSync(context, { recursive: true });
  const archive = join(context, 'source.tar');
  run('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', `--output=${archive}`, sha], { cwd });
  run('tar', ['-xf', archive, '-C', context]);
  rmSync(archive);
  // git archive is the only source; ignored files from the checkout never enter the context.
  mkdirSync(join(context, '.release'));
  writeFileSync(join(context, '.release/source.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function validateImageIdentity(inspect, release, expectedSha, expectedTree) {
  const labels = inspect.Config?.Labels ?? {};
  if (release.gitSha !== expectedSha || release.gitTree !== expectedTree
    || labels['org.opencontainers.image.revision'] !== expectedSha
    || labels['com.b24.git-tree'] !== expectedTree) throw new Error('Image label, release metadata and expected Git SHA/tree disagree');
}

export function guard(cwd, image, expectedSha, bootstrapSha) {
  cleanHead(cwd, expectedSha);
  const expected = gitManifest(cwd, expectedSha);
  const candidate = JSON.parse(run('docker', ['image', 'inspect', image]))[0];
  const imageId = candidate.Id;
  const isolated = ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', imageId];
  const metadata = JSON.parse(run('docker', [...isolated, 'scripts/b24-release-integrity.mjs', 'verify']));
  validateImageIdentity(candidate, metadata, expectedSha, expected.gitTree);
  const candidateSource = JSON.parse(run('docker', [...isolated, '-e', "process.stdout.write(require('fs').readFileSync('.release/source.json','utf8'))"]));
  compareFiles(expected.files, candidateSource.files, 'Candidate source manifest differs from Git');

  const current = JSON.parse(run('docker', ['container', 'inspect', 'b24-backend']))[0];
  if (!current.State.Running || !current.NetworkSettings.Networks.erpnext_frappe_network) throw new Error('Current backend must be running on erpnext_frappe_network');
  const currentSha = current.Config.Labels?.['org.opencontainers.image.revision'];
  const baseline = currentSha || bootstrapSha;
  if (!validSha(baseline)) throw new Error('Legacy image has no SHA: supply a verified full baseline SHA as the fourth argument for first migration');
  run('git', ['merge-base', '--is-ancestor', baseline, expectedSha], { cwd });
  const oldExpected = gitManifest(cwd, baseline, { normalizeEol: !currentSha });
  if (currentSha) {
    const oldMetadata = JSON.parse(run('docker', ['exec', current.Id, 'node', 'scripts/b24-release-integrity.mjs', 'verify']));
    validateImageIdentity(current, oldMetadata, baseline, oldExpected.gitTree);
    const oldSource = JSON.parse(run('docker', ['exec', current.Id, 'node', '-e', "process.stdout.write(require('fs').readFileSync('.release/source.json','utf8'))"]));
    compareFiles(oldExpected.files, oldSource.files, 'Production source manifest differs from its Git SHA');
  } else {
    for (const path of ['Dockerfile', '.dockerignore', 'scripts/b24-release-integrity.mjs', 'docs/contracts/order-created.v1.example.json']) delete oldExpected.files[path];
    // The old Dockerfile rewrites this package export after bundling shared code.
    const shared = run('git', ['show', `${baseline}:packages/shared/package.json`], { cwd });
    oldExpected.files['packages/shared/package.json'] = sha256(shared.replaceAll('./src/index.ts', './dist/index.js'));
    const program = readFileSync(join(cwd, 'scripts/b24-release-integrity.mjs'), 'utf8');
    const actual = JSON.parse(run('docker', ['exec', '-i', current.Id, 'node', '--input-type=module', '-', 'snapshot'], { input: program }));
    compareFiles(oldExpected.files, actual, 'Legacy production sources differ from the supplied baseline');
  }
  // Keep the existing source continuity check mandatory as well.
  run('bash', ['scripts/b24-release-source-guard.sh', imageId, current.Id], { cwd });
  return { gitSha: expectedSha, imageId, previousContainerId: current.Id, previousGitSha: baseline };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, arg, sha, bootstrap] = process.argv.slice(2);
    const cwd = process.cwd();
    if (command === 'prepare') {
      if (!arg) throw new Error('Usage: prepare NEW_OUTPUT_DIRECTORY');
      const manifest = prepare(cwd, arg);
      console.log(JSON.stringify({ context: resolve(arg), gitSha: manifest.gitSha, gitTree: manifest.gitTree }));
    } else if (command === 'build') {
      const parent = mkdtempSync(join(tmpdir(), 'b24-release-'));
      try {
        const context = join(parent, 'source');
        const manifest = prepare(cwd, context);
        run(process.execPath, ['--test', 'scripts/b24-release.test.mjs'], { cwd: context, stdio: 'inherit' });
        const image = arg || `b24-app:git-${manifest.gitSha}`;
        run('docker', ['build', '--build-arg', `RELEASE_SHA=${manifest.gitSha}`, '--build-arg', `RELEASE_TREE=${manifest.gitTree}`, '-t', image, context], { stdio: 'inherit' });
        console.log(JSON.stringify({ image, gitSha: manifest.gitSha }));
      } finally { rmSync(parent, { recursive: true, force: true }); }
    } else if (command === 'guard') {
      if (!arg || !sha) throw new Error('Usage: guard IMAGE FULL_SHA [LEGACY_BASELINE_FULL_SHA]');
      console.log(JSON.stringify(guard(cwd, arg, sha, bootstrap)));
    } else throw new Error('Usage: b24-release.mjs prepare|build|guard ...');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
