// Diagnostic for SUP-02/STOCK-02/INV-05. Expected to fail until the contracts are restored.
// All ERP/Bitrix calls in the fixture are mocked. No credentials are used.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(root, 'packages/backend');
const target = resolve(workspace, `src/routes/route-guards-${process.pid}.audit.ts`);
writeFileSync(target, readFileSync(resolve(root, 'docs/audits/fixtures/route-guards.test.txt')), { flag: 'wx' });
try {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', target], {
    cwd: workspace, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(target);
}
