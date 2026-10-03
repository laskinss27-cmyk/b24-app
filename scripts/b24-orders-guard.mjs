import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {run,cleanHead,gitManifest,validateImageIdentity} from './b24-release.mjs';
import {compareFiles,sha256,validSha} from './b24-release-integrity.mjs';
export function guardOrders(cwd,image,sha,bootstrap) {
  cleanHead(cwd,sha);
  if(image!==`b24-orders:git-${sha}`)throw Error('Use a full-SHA orders image');
  const expected=gitManifest(cwd,sha),candidate=JSON.parse(run('docker',['image','inspect',image]))[0];
  const isolated=['run','--rm','--network','none','--read-only','--entrypoint','node',candidate.Id];
  const release=JSON.parse(run('docker',[...isolated,'scripts/b24-release-integrity.mjs','verify']));
  validateImageIdentity(candidate,release,sha,expected.gitTree);
  const source=JSON.parse(run('docker',[...isolated,'-e',"process.stdout.write(require('fs').readFileSync('.release/source.json','utf8'))"]));
  compareFiles(expected.files,source.files,'Receiver candidate differs from Git');
  const containers={};
  for(const name of ['b24-orders-receiver-1','b24-orders-worker-1']) {
    const current=JSON.parse(run('docker',['inspect',name]))[0];
    if(!current.State.Running || !current.NetworkSettings.Networks.b24_orders_orders && !current.NetworkSettings.Networks['b24-orders_orders'])throw Error('Unexpected receiver network/state');
    const label=current.Config.Labels?.['org.opencontainers.image.revision'];
    const baseline=validSha(label)?label:bootstrap;
    if(!validSha(baseline)||!label||!baseline.startsWith(label))throw Error('Verified receiver baseline required');
    run('git',['merge-base','--is-ancestor',baseline,sha],{cwd});
    if(validSha(label)) {
      const oldRelease=JSON.parse(run('docker',['exec',current.Id,'node','scripts/b24-release-integrity.mjs','verify']));
      validateImageIdentity(current,oldRelease,baseline,gitManifest(cwd,baseline).gitTree);
    } else {
      const oldExpected=gitManifest(cwd,baseline,{normalizeEol:true});
      for(const file of Object.keys(oldExpected.files))if(!file.startsWith('packages/')&&!['package.json','package-lock.json','tsconfig.base.json'].includes(file))delete oldExpected.files[file];
      oldExpected.files['packages/shared/package.json']=sha256(run('git',['show',`${baseline}:packages/shared/package.json`],{cwd}).replaceAll('./src/index.ts','./dist/index.js').replaceAll('\r\n','\n'));
      const program=readFileSync(join(cwd,'scripts/b24-release-integrity.mjs'),'utf8');
      const actual=JSON.parse(run('docker',['exec','-i',current.Id,'node','--input-type=module','-','snapshot'],{input:program}));
      compareFiles(oldExpected.files,actual,'Legacy receiver source mismatch');
    }
    run('bash',['scripts/b24-release-source-guard.sh',candidate.Id,current.Id],{cwd});
    containers[name]={id:current.Id,imageId:current.Image,gitSha:baseline};
  }
  return {gitSha:sha,imageId:candidate.Id,containers};
}
