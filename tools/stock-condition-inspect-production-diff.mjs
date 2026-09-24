import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
const audit=JSON.parse(await fs.readFile('outputs/stock-conditions/release-base-check.json','utf8'));
const script=`import fs from 'node:fs';console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(audit.differences)}.map(f=>[f,fs.readFileSync('/app/'+f,'utf8')]))));`;
const r=spawnSync('ssh',['-i','C:/Users/LapTOP/.ssh/b24_company','-o','IdentitiesOnly=yes','-o','BatchMode=yes','root@201.51.12.57','docker exec -i b24-backend node --input-type=module -'],{input:script,encoding:'utf8',windowsHide:true});if(r.status)throw Error(r.stderr);
const remote=JSON.parse(r.stdout);await fs.mkdir('outputs/stock-conditions/production-reference',{recursive:true});
for(const [file,content] of Object.entries(remote)){
	const stem=file.replaceAll('/','_');const local=`outputs/stock-conditions/production-reference/${stem}.base`,running=`outputs/stock-conditions/production-reference/${stem}.running`;
	const base=spawnSync('git',['show',`HEAD:${file}`],{encoding:'utf8',windowsHide:true});if(base.status)throw Error(base.stderr);
	await fs.writeFile(local,base.stdout.replaceAll('\r\n','\n'));await fs.writeFile(running,String(content).replaceAll('\r\n','\n'));
	const diff=spawnSync('git',['diff','--no-index','--',local,running],{encoding:'utf8',windowsHide:true});console.log(diff.stdout);
}
