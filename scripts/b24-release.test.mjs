import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanHead, prepare, run, validateImageIdentity } from './b24-release.mjs';
import { snapshot, checkInput, seal, verify } from './b24-release-integrity.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'b24-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.base.json']) write(name, '{}\n');
  for (const name of ['Dockerfile', '.dockerignore', 'scripts/b24-release-integrity.mjs']) write(name, '# fixture\n');
  write('docs/contracts/order-created.v1.example.json', '{}\n');
  write('packages/backend/src/app.ts', 'export const marker = "committed";\n');
  return { root, write };
}

function imageFixture(t) {
  const f = fixture(t);
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
  f.write('.release/source.json', JSON.stringify({ schema: 1, gitSha: sha, gitTree: tree, files: snapshot(f.root) }));
  return { ...f, sha, tree };
}

test('build rejects missing provenance, wrong SHA and changed/untracked source files', (t) => {
  const { root, write, sha, tree } = imageFixture(t);
  assert.equal(checkInput(root, sha, tree).gitSha, sha);
  assert.throws(() => checkInput(root, 'c'.repeat(40), tree), /does not match/);
  write('packages/backend/src/app.ts', 'changed');
  assert.throws(() => checkInput(root, sha, tree), /app.ts/);
  write('packages/backend/src/app.ts', 'export const marker = "committed";\n');
  write('packages/backend/src/forgotten.ts', 'untracked');
  assert.throws(() => checkInput(root, sha, tree), /forgotten.ts/);
  rmSync(join(root, '.release/source.json'));
  assert.throws(() => checkInput(root, sha, tree), /ENOENT/);
});

test('image seal requires the catalog modules and verifies compiled artifacts and metadata', (t) => {
  const { root, write, sha } = imageFixture(t);
  const artifacts = [
    'packages/backend/dist/server.js', 'packages/backend/dist/catalog-mirror/reader.js',
    'packages/backend/dist/catalog-mirror/live-stock.js', 'packages/frontend/dist/index.html', 'packages/shared/dist/index.js',
  ];
  assert.throws(() => seal(root), /Missing runtime artifact/);
  for (const name of artifacts) write(name, 'build output');
  write('packages/backend/src/app.ts', 'unexpected edit during build');
  assert.throws(() => seal(root), /Sources changed during tests\/build/);
  write('packages/backend/src/app.ts', 'export const marker = "committed";\n');
  seal(root);
  assert.equal(verify(root).gitSha, sha);
  write(artifacts[1], 'hotfix after build');
  assert.throws(() => verify(root), /catalog-mirror\/reader.js/);
  write(artifacts[1], 'build output');
  write('packages/backend/dist/uncommitted.js', 'extra runtime code');
  assert.throws(() => verify(root), /uncommitted.js/);
  rmSync(join(root, 'packages/backend/dist/uncommitted.js'));
  const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
  write('release.json', JSON.stringify({ ...release, tests: ['backend'] }));
  assert.throws(() => verify(root), /test record mismatch/);
});

test('a release tag is insufficient when image labels or metadata have another SHA', () => {
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
  const image = { Config: { Labels: { 'org.opencontainers.image.revision': sha, 'com.b24.git-tree': tree } } };
  validateImageIdentity(image, { gitSha: sha, gitTree: tree }, sha, tree);
  assert.throws(() => validateImageIdentity(image, { gitSha: 'c'.repeat(40), gitTree: tree }, sha, tree), /disagree/);
  assert.throws(() => validateImageIdentity({ Config: {} }, { gitSha: sha, gitTree: tree }, sha, tree), /disagree/);
});

test('prepare blocks dirty, staged and unpushed changes and archives only committed bytes', (t) => {
  const { root, write } = fixture(t);
  const remote = mkdtempSync(join(tmpdir(), 'b24-release-remote-'));
  const outputParent = mkdtempSync(join(tmpdir(), 'b24-release-output-'));
  t.after(() => { rmSync(remote, { recursive: true, force: true }); rmSync(outputParent, { recursive: true, force: true }); });
  const git = (...args) => run('git', args, { cwd: root });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  write('.gitignore', '.env\nnode_modules/\n');
  git('add', '.'); git('commit', '-m', 'initial');
  run('git', ['init', '--bare', remote]);
  git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  const sha = cleanHead(root);
  write('untracked.txt', 'forgotten');
  assert.throws(() => cleanHead(root), /modified\/staged\/untracked/);
  rmSync(join(root, 'untracked.txt'));
  write('packages/backend/src/app.ts', 'changed');
  assert.throws(() => cleanHead(root), /modified\/staged\/untracked/);
  git('add', '.');
  assert.throws(() => cleanHead(root), /modified\/staged\/untracked/);
  git('commit', '-m', 'not pushed');
  assert.throws(() => cleanHead(root), /not the current pushed/);
  git('push');
  assert.throws(() => cleanHead(root, sha), /Expected full SHA/);
  write('.env', 'secret must never enter archive');
  write('node_modules/ignored.js', 'local dependency');
  const output = join(outputParent, 'context');
  const manifest = prepare(root, output);
  assert.equal(manifest.gitSha, cleanHead(root));
  assert.equal(readFileSync(join(output, 'packages/backend/src/app.ts'), 'utf8'), 'changed');
  assert.equal(existsSync(join(output, '.env')), false);
  assert.equal(existsSync(join(output, 'node_modules')), false);
  assert.equal(checkInput(output, manifest.gitSha, manifest.gitTree).gitSha, manifest.gitSha);
});
