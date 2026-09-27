import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const legacyRoots = ['package.json', 'package-lock.json', 'tsconfig.base.json', 'packages'];
export const sourceRoots = [...legacyRoots, 'Dockerfile', '.dockerignore', 'scripts/b24-release-integrity.mjs', 'docs/contracts/order-created.v1.example.json'];
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const validSha = (value) => /^[a-f0-9]{40}$/.test(value ?? '');

// These paths are excluded by .dockerignore or produced by the build itself.
export function isSourcePath(path) {
  const parts = path.split('/');
  return !parts.some((part) => ['node_modules', 'dist', '.git'].includes(part)
    || part === '.env' || part.startsWith('.env.'))
    && !/\.(map|tsbuildinfo)$/.test(path);
}

export function snapshot(root, { artifacts = false, legacy = false } = {}) {
  const files = {};
  function visit(path) {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const full = resolve(path, item.name);
      const name = relative(root, full).replaceAll('\\', '/');
      if (item.name === 'node_modules') continue;
      if (!artifacts && !isSourcePath(name)) continue;
      if (item.isSymbolicLink()) throw new Error(`Unexpected symlink in release: ${name}`);
      if (item.isDirectory()) visit(full);
      else files[name] = sha256(readFileSync(full));
    }
  }
  for (const name of legacy ? legacyRoots : sourceRoots) {
    const path = resolve(root, name);
    if (name === 'packages') visit(path);
    else files[name] = sha256(readFileSync(path));
  }
  if (artifacts) {
    for (const name of ['scripts/b24-release-integrity.mjs', '.release/source.json', 'release.json']) {
      files[name] = sha256(readFileSync(resolve(root, name)));
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

export function compareFiles(expected, actual, label) {
  const differences = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((name) => expected[name] !== actual[name]);
  if (differences.length) throw new Error(`${label}: missing, changed or unexpected files:\n${differences.join('\n')}`);
}

export function readManifest(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, '.release/source.json'), 'utf8'));
  if (manifest.schema !== 1 || !validSha(manifest.gitSha) || !validSha(manifest.gitTree)
    || !manifest.files || !Object.keys(manifest.files).length) throw new Error('Invalid Git source manifest');
  return manifest;
}

export function checkInput(root, gitSha, gitTree) {
  const manifest = readManifest(root);
  if (manifest.gitSha !== gitSha || manifest.gitTree !== gitTree) throw new Error('Build SHA/tree does not match the source manifest');
  compareFiles(manifest.files, snapshot(root), 'Build context differs from committed Git sources');
  return manifest;
}

export function seal(root) {
  const manifest = readManifest(root);
  const sources = snapshot(root);
  const sharedPackage = 'packages/shared/package.json';
  if (manifest.files[sharedPackage]) {
    // The only intentional source rewrite in Dockerfile is the bundled shared export.
    sources[sharedPackage] = sha256(readFileSync(resolve(root, sharedPackage), 'utf8').replaceAll('./dist/index.js', './src/index.ts'));
  }
  compareFiles(manifest.files, sources, 'Sources changed during tests/build');
  for (const name of [
    'packages/backend/dist/server.js',
    'packages/backend/dist/catalog-mirror/reader.js',
    'packages/backend/dist/catalog-mirror/live-stock.js',
    'packages/frontend/dist/index.html',
    'packages/shared/dist/index.js',
  ]) {
    if (!existsSync(resolve(root, name)) || !readFileSync(resolve(root, name)).length) throw new Error(`Missing runtime artifact: ${name}`);
  }
  const release = {
    schema: 1, gitSha: manifest.gitSha, gitTree: manifest.gitTree,
    builtAt: new Date().toISOString(), tests: ['backend', 'frontend'],
    sourceDigest: sha256(readFileSync(resolve(root, '.release/source.json'))),
  };
  writeFileSync(resolve(root, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(resolve(root, '.release/artifacts.json'), `${JSON.stringify(snapshot(root, { artifacts: true }), null, 2)}\n`);
  return release;
}

export function verify(root) {
  const manifest = readManifest(root);
  const release = JSON.parse(readFileSync(resolve(root, 'release.json'), 'utf8'));
  if (release.schema !== 1 || release.gitSha !== manifest.gitSha || release.gitTree !== manifest.gitTree
    || release.sourceDigest !== sha256(readFileSync(resolve(root, '.release/source.json')))
    || JSON.stringify(release.tests) !== JSON.stringify(['backend', 'frontend'])) throw new Error('Release metadata/test record mismatch');
  compareFiles(JSON.parse(readFileSync(resolve(root, '.release/artifacts.json'), 'utf8')),
    snapshot(root, { artifacts: true }), 'Image/runtime integrity failed');
  return release;
}

// Also supports `docker exec -i ... node --input-type=module - snapshot` for legacy images.
if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  try {
    const [command, sha, tree] = process.argv.slice(2);
    const root = process.cwd();
    const result = command === 'snapshot' ? snapshot(root, { legacy: true })
      : command === 'check-input' ? checkInput(root, sha, tree)
        : command === 'seal' ? seal(root)
          : command === 'verify' ? verify(root) : null;
    if (!result) throw new Error('Usage: check-input SHA TREE | seal | verify | snapshot');
    console.log(JSON.stringify(command === 'check-input' ? { inputVerified: result.gitSha } : result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
