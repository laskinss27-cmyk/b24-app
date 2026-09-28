import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// npm workspace scripts run in that workspace, preserving its JSX/TS config.
const files = readdirSync(resolve('src'), { recursive: true })
  .filter((name) => /\.test\.tsx?$/.test(name))
  .map((name) => `src/${name.replaceAll('\\', '/')}`)
  .sort();
if (!files.length) throw new Error('No workspace tests found');
console.log(`Discovered ${files.length} test files in ${process.cwd()}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
