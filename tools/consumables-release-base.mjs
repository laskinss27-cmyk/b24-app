import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
const cwd = 'D:/Projects/b24-app/outputs/consumables/release-worktree';
const run = (cmd, args, extra = {}) => {
 const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024, ...extra });
 if (r.status !== 0) throw Error(r.stderr || `${cmd} failed`);
 return r.stdout;
};
const files = run('git', ['ls-tree', '-r', '--name-only', '416376d', '--', 'packages', 'package.json', 'package-lock.json', 'tsconfig.base.json'])
 .trim().split(/\r?\n/).filter(f => /\.(ts|tsx|js|mjs|css|json|html|svg)$/.test(f) && f !== 'packages/shared/package.json');
const hash = text => createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const baseline = Object.fromEntries(files.map(f => [f, hash(run('git', ['show', `416376d:${f}`]))]));
const script = `import fs from 'node:fs';import {createHash} from 'node:crypto';const files=${JSON.stringify(files)};console.log(JSON.stringify(Object.fromEntries(files.map(f=>{try{return[f,createHash('sha256').update(fs.readFileSync('/app/'+f,'utf8').replaceAll('\\r\\n','\\n')).digest('hex')]}catch{return[f,null]}}))));`;
const remote = JSON.parse(run('ssh', ['-i','C:/Users/LapTOP/.ssh/b24_company','-o','IdentitiesOnly=yes','-o','BatchMode=yes','root@201.51.12.57','docker exec -i b24-backend node --input-type=module -'], { input: script }));
const differences = files.filter(f => baseline[f] !== remote[f]);
const result = { generatedAt: new Date().toISOString(), checked: files.length, differences, baseline, remote };
await fs.writeFile('D:/Projects/b24-app/outputs/consumables/release-base-check.json', JSON.stringify(result,null,2));
console.log(JSON.stringify({ checked: files.length, differences }));
if(differences.length) process.exitCode=1;
