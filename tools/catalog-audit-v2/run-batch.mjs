import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {isExcludedKit} from './scope.mjs';

const [specPath, mode = 'dry-run'] = process.argv.slice(2);
if (!specPath || !['dry-run','apply'].includes(mode)) throw new Error('Usage: run-batch.mjs <spec-module> [dry-run|apply]');
const spec = (await import(pathToFileURL(path.resolve(specPath)).href)).default;
const before = JSON.parse(await fs.readFile(spec.beforePath,'utf8'));
if (new Set(spec.items.map(row=>row.itemCode)).size !== spec.items.length) throw new Error('Duplicate item codes');
for (const row of spec.items) {
  const saved = before.snapshot.find(entry=>entry.itemCode===row.itemCode);
  if (saved && isExcludedKit(saved.item.item_name)) throw new Error(`Kit excluded by user: ${row.itemCode}`);
  if (!saved || saved.control.Bin.reduce((sum,bin)=>sum+Number(bin.actual_qty),0)<=0) throw new Error(`Not in stock: ${row.itemCode}`);
  if (!row.sources.length || !/[а-яё]/iu.test(row.summary)) throw new Error('Missing sources or Russian summary');
  if (new Set(row.attributes.map(a=>a.key)).size !== row.attributes.length) throw new Error('Duplicate attribute keys');
  row.before = saved;
}
const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
const directory = 'catalog-audit-v2/progress';
const proposalPath = `${directory}/batch-${spec.batch}-proposal.json`;
if (mode === 'apply') {
  const approved = JSON.parse(await fs.readFile(proposalPath,'utf8'));
  if (approved.specHash !== specHash || approved.mode !== 'dry-run' || approved.reports.length !== spec.items.length) throw new Error('Run dry-run for this exact proposal first');
}
const remote = await fs.readFile('tools/catalog-audit-v2/batch-remote.mjs','utf8');
const input = `const SPEC = ${JSON.stringify(spec)};\nconst APPLY = ${mode==='apply'};\n${remote}`;
const host = process.env.B24_AUDIT_SSH_HOST;
const key = process.env.B24_AUDIT_SSH_KEY;
if (!host || !key) throw new Error('SSH configuration missing');
const outPath = mode==='apply' ? `${directory}/batch-${spec.batch}-applied.json` : proposalPath;
const eventPath = `${directory}/batch-${spec.batch}-${mode}-events.ndjson`;
const eventHandle = await fs.open(eventPath,'a');
const child = spawn('ssh',['-i',key,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15',host,'docker exec -i b24-backend node --input-type=module -'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const stdout=[]; const stderr=[]; const writes=[];
child.stdout.on('data',chunk=>stdout.push(chunk));
child.stderr.on('data',chunk=>{stderr.push(chunk);writes.push(eventHandle.write(chunk));});
child.stdin.end(input,'utf8');
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
await Promise.all(writes); await eventHandle.close();
if(code!==0) throw new Error(Buffer.concat(stderr).toString('utf8').slice(-5000)||`SSH exit ${code}`);
const result={...JSON.parse(Buffer.concat(stdout).toString('utf8')),specHash};
await fs.writeFile(outPath,JSON.stringify(result,null,2)+'\n','utf8');
console.log(JSON.stringify({output:outPath,mode:result.mode,reports:result.reports.map(({itemCode,attributes,protectedDescription,verified})=>({itemCode,attributes,protectedDescription,verified}))},null,2));
