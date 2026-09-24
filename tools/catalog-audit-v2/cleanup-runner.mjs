import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cleanSummary} from './cleanup-notes.mjs';
const mode=process.argv[2];
if(!['backup','apply','verify'].includes(mode))throw Error('Use backup|apply|verify');
const dir=process.env.B24_CLEANUP_DIR??'outputs/catalog-cleanup-2026-09-07';
const proposal=await fs.readFile(`${dir}/proposal.json`,'utf8');
const proposalHash=createHash('sha256').update(proposal).digest('hex');
let input;
if(mode==='backup')input={mode,proposalHash,candidates:JSON.parse(proposal).candidates.map(c=>({...c,descriptionAfter:cleanSummary(c.descriptionBefore)}))};
else{
 const backup=JSON.parse(await fs.readFile(`${dir}/backup.json`,'utf8'));
 if(backup.proposalHash!==proposalHash)throw Error('Proposal changed after backup');
 input={...backup,mode};
 if(process.argv[3]){const ids=new Set(process.argv[3].split(','));input.records=input.records.filter(r=>ids.has(r.id));if(input.records.length!==ids.size)throw Error('Unknown requested IDs');}
}
const remote=await fs.readFile('tools/catalog-audit-v2/cleanup-remote.mjs','utf8');
const child=spawn('ssh',['-i','C:/Users/LapTOP/.ssh/b24_company','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15','root@201.51.12.57','docker exec -i b24-backend node --input-type=module -'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const stdout=[],stderr=[];
const suffix=process.argv[3]?'-canary':'';
const events=await fs.open(`${dir}/${mode}${suffix}-events.ndjson`,'a');
const writes=[];
child.stdout.on('data',chunk=>stdout.push(chunk));
child.stderr.on('data',chunk=>{stderr.push(chunk);writes.push(events.write(chunk));process.stderr.write(chunk);});
child.stdin.end(`globalThis.__CLEANUP_INPUT__=${JSON.stringify(input)};\n${remote}`,'utf8');
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
await Promise.all(writes);await events.close();
if(code!==0)throw Error(Buffer.concat(stderr).toString('utf8').slice(-1800));
const result=JSON.parse(Buffer.concat(stdout).toString('utf8'));
await fs.writeFile(`${dir}/${mode}${suffix}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({mode,count:result.records.length,output:`${dir}/${mode}${suffix}.json`}));
