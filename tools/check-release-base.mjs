import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
const [cwd,ref,output]=process.argv.slice(2);
if(!cwd||!ref||!output)throw Error('Usage: cwd ref output');
function run(cmd,args,extra={}){const r=spawnSync(cmd,args,{cwd,windowsHide:true,maxBuffer:50*1024*1024,...extra});if(r.status!==0)throw Error(String(r.stderr));return r.stdout;}
const files=String(run('git',['ls-tree','-r','--name-only',ref,'--','packages','package.json','package-lock.json','tsconfig.base.json']))
 .trim().split(/\r?\n/).filter(f=>/\.(ts|tsx|js|mjs|css|json|html|svg)$/.test(f)&&f!=='packages/shared/package.json');
const hash=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const batch=run('git',['cat-file','--batch'],{input:files.map(f=>`${ref}:${f}\n`).join('')});
let offset=0;const baseline={};
for(const file of files){const end=batch.indexOf(10,offset);const header=batch.subarray(offset,end).toString('utf8');const size=Number(header.split(' ')[2]);if(!Number.isSafeInteger(size))throw Error('Invalid git blob header');offset=end+1;baseline[file]=hash(batch.subarray(offset,offset+size).toString('utf8'));offset+=size+1;}
const script=`import fs from 'node:fs';import {createHash} from 'node:crypto';const files=${JSON.stringify(files)};console.log(JSON.stringify(Object.fromEntries(files.map(f=>{try{return[f,createHash('sha256').update(fs.readFileSync('/app/'+f,'utf8').replaceAll('\\r\\n','\\n')).digest('hex')]}catch{return[f,null]}}))));`;
const remote=JSON.parse(String(run('ssh',['-i','C:/Users/LapTOP/.ssh/b24_company','-o','IdentitiesOnly=yes','-o','BatchMode=yes','root@201.51.12.57','docker exec -i b24-backend node --input-type=module -'],{input:script})));
const differences=files.filter(f=>baseline[f]!==remote[f]);
await fs.writeFile(output,JSON.stringify({generatedAt:new Date().toISOString(),ref,checked:files.length,differences,baseline,remote},null,2));
console.log(JSON.stringify({checked:files.length,differences}));if(differences.length)process.exitCode=1;
