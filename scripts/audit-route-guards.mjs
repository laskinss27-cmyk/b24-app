// Focused SUP-02/STOCK-02/INV-05 checks; also included in the ordinary backend suite.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  'src/routes/restored-contracts.test.ts', 'src/routes/receipt-price-validation.test.ts',
  'src/routes/api-supply-request-note.test.ts', 'src/routes/inventory-draft-save-guard.test.ts'],
  { cwd: resolve(root, 'packages/backend'), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
