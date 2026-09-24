import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const cwd='D:/Projects/b24-app/outputs/stock-conditions/production-worktree';
const key='C:/Users/LapTOP/.ssh/b24_company',host='root@201.51.12.57';
const expectedId='35dd49a556a5e7f4880c72eab8d4ea298b58058e83f5980e335c685ad4ea84d5';
const commit='7c19896';
const release=commit+'-stock-conditions-'+new Date().toISOString().replace(/\D/g,'');
const local='D:/Projects/b24-app/outputs/stock-conditions/production-release-'+commit+'.tgz';
const remote='/tmp/b24-stock-conditions-release-'+release+'.tgz';
const output=[];
async function run(cmd,args,input){
 const child=spawn(cmd,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output.push(b);process.stdout.write(b);});
 child.stdin.end(input);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 if(code!==0)throw Error(`${cmd} exited ${code}`);
}
try{
 await run('git',['diff','--exit-code']);
 await run('git',['diff','--cached','--exit-code']);
 await run('git',['archive','--format=tar.gz','--output='+local,commit,'packages','package.json','package-lock.json','tsconfig.base.json','Dockerfile','.dockerignore']);
 const sha=createHash('sha256').update(await fs.readFile(local)).digest('hex');
 await run('scp',['-i',key,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',local,host+':'+remote]);
 const script=(await fs.readFile('D:/Projects/b24-app/tools/deploy-consumables.sh','utf8')).replaceAll('\r\n','\n');
 await run('ssh',['-i',key,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',host,`bash -s -- ${remote} ${release} ${expectedId} ${sha}`],script);
 await fs.writeFile('D:/Projects/b24-app/outputs/stock-conditions/production-deployment.json',JSON.stringify({generatedAt:new Date().toISOString(),release,expectedPreviousId:expectedId,archiveSha256:sha,success:true},null,2));
}finally{await fs.writeFile('D:/Projects/b24-app/outputs/stock-conditions/production-deployment.log',Buffer.concat(output));}
