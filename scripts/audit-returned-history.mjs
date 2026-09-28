// Diagnostic for REAL-03. Expected to fail until the historical rule is restored.
// Uses FakeErp from the current test suite; never connects to production.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(root, 'packages/backend');
const target = resolve(workspace, `src/erp/returned-history-${process.pid}.audit.ts`);
const suite = readFileSync(resolve(workspace, 'src/erp/operations.test.ts'), 'utf8');
const fixture = readFileSync(resolve(root, 'docs/audits/fixtures/fully-returned-history.test.txt'), 'utf8');
writeFileSync(target, `${suite}\n${fixture}`, { flag: 'wx' });
try {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--test',
    '--test-name-pattern=^price change leaves fully returned realization history untouched$',
    target,
  ], { cwd: workspace, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(target);
}
