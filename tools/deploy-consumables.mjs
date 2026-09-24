import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const cwd='D:/Projects/b24-app/outputs/consumables/release-worktree';
const key='C:/Users/LapTOP/.ssh/b24_company',host='root@201.51.12.57';
const expectedId='536617120dd75783ce0729683120b99b85a1b08b764c6e6a7492fa5203a9e672';
const release='04b9e37-consumables-'+new Date().toISOString().replace(/\D/g,'');
const local='D:/Projects/b24-app/outputs/consumables/release-04b9e37.tgz';
const remote='/tmp/b24-consumables-release-'+release+'.tgz';
const output=[];
async function run(cmd,args,input){
 const child=spawn(cmd,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr]) stream.on('data',b=>{output.push(b);process.stdout.write(b);});
 child.stdin.end(input);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 if(code!==0)throw Error(`${cmd} exited ${code}`);
}
try{
 await run('git',['diff','--exit-code']);
 await run('git',['archive','--format=tar.gz','--output='+local,'04b9e37','packages','package.json','package-lock.json','tsconfig.base.json','Dockerfile','.dockerignore']);
 const sha=createHash('sha256').update(await fs.readFile(local)).digest('hex');
 await run('scp',['-i',key,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',local,host+':'+remote]);
 const script=(await fs.readFile('D:/Projects/b24-app/tools/deploy-consumables.sh','utf8')).replaceAll('\r\n','\n');
 await run('ssh',['-i',key,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',host,`bash -s -- ${remote} ${release} ${expectedId} ${sha}`],script);
 await fs.writeFile('D:/Projects/b24-app/outputs/consumables/deployment.json',JSON.stringify({generatedAt:new Date().toISOString(),release,expectedPreviousId:expectedId,archiveSha256:sha,success:true},null,2));
}finally{await fs.writeFile('D:/Projects/b24-app/outputs/consumables/deployment.log',Buffer.concat(output));}
