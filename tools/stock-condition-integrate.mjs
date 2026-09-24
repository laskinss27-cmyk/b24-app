import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {changedFiles,addedFiles} from './stock-condition-release-files.mjs';
const root=process.cwd();
const target=path.join(root,'outputs/stock-conditions/release-worktree');
for(const file of changedFiles){
 const base=spawnSync('git',['show',`HEAD:${file}`],{encoding:'utf8'});
 if(base.status!==0)throw Error(base.stderr);
 const temp=path.join(root,'outputs/stock-conditions/merge-base.tmp');
 const current=spawnSync('git',['show',`6e1bd92:${file}`],{encoding:'utf8'});
 if(current.status!==0)throw Error(current.stderr);
 fs.writeFileSync(temp,base.stdout.replaceAll('\r\n','\n'));
 fs.writeFileSync(temp+'.current',current.stdout.replaceAll('\r\n','\n'));
 fs.writeFileSync(temp+'.feature',fs.readFileSync(path.join(root,file),'utf8').replaceAll('\r\n','\n'));
 const merged=spawnSync('git',['merge-file','-p','-L','production','-L','base','-L','feature',temp+'.current',temp,temp+'.feature'],{encoding:'utf8'});
 if(merged.status===null||merged.status>127)throw Error(merged.stderr);
 fs.writeFileSync(path.join(target,file),merged.stdout);
 console.log(`${merged.status?'CONFLICT':'merged'} ${file}`);
}
for(const file of [...addedFiles,'packages/backend/src/erp/stock-conditions.test.ts','packages/frontend/src/stock-conditions.test.ts','packages/frontend/src/dev-stock-condition-preview.tsx','packages/frontend/stock-condition-preview.html']){
 fs.mkdirSync(path.dirname(path.join(target,file)),{recursive:true});
 fs.copyFileSync(path.join(root,file),path.join(target,file));
}
