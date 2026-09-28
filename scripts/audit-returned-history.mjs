// Focused REAL-03 regression check; also included in the ordinary backend suite.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  '--test-name-pattern=price change leaves fully returned|price sync preserves returned',
  'src/erp/operations.test.ts'], { cwd: resolve(root, 'packages/backend'), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
