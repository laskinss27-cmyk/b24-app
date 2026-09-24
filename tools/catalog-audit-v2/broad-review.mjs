import fs from 'node:fs/promises';
import {isExcludedKit} from './scope.mjs';
const dir='catalog-audit-v2/progress';
const audit=JSON.parse(await fs.readFile(dir+'/stock-completeness-latest.json','utf8'));
const progress=JSON.parse(await fs.readFile(dir+'/progress.json','utf8'));
let manifest;
try{manifest=JSON.parse(await fs.readFile(dir+'/broad-review-manifest.json','utf8'));}
catch(e){
 if(e.code!=='ENOENT')throw e;
 const seen=new Set([...progress.completed,...progress.reviews,...progress.excludedKits].map(i=>i.id));
 const items=audit.items.filter(i=>!seen.has(i.id)&&!isExcludedKit(i.name));
 manifest={createdAt:new Date().toISOString(),inventoryAt:audit.generatedAt,ids:items.map(i=>i.id),note:'Stable read-only review list. Inclusion is not a defect finding; no automatic adequate decisions.'};
 await fs.writeFile(dir+'/broad-review-manifest.json',JSON.stringify(manifest,null,2)+'\n');
}
const start=Number(process.argv[2]||0),count=Number(process.argv[3]||20);
if(!Number.isInteger(start)||!Number.isInteger(count)||start<0||count<1)throw new Error('Bad slice');
console.log(JSON.stringify({total:manifest.ids.length,start,end:Math.min(start+count,manifest.ids.length)}));
const displayed=[];
for(const id of manifest.ids.slice(start,start+count)){
 const i=audit.items.find(i=>i.id===id);if(!i)throw new Error('Not present '+id);
 const attrs=i.content.attributes.map(a=>[a.label,a.rawValue,a.unit]);
 let best=null,score=0;
 for(const prior of displayed){
  const same=attrs.filter(a=>prior.attrs.some(b=>JSON.stringify(a)===JSON.stringify(b))).length;
  if(same>score){best=prior;score=same;}
 }
 const delta=best&&score>=8&&score>=attrs.length*.5?{sameAttributesAs:best.id,identicalAttributes:score,changedOrAdded:attrs.filter(a=>!best.attrs.some(b=>JSON.stringify(a)===JSON.stringify(b))),removed:best.attrs.filter(a=>!attrs.some(b=>b[0]===a[0])).map(a=>a[0])}:{attrs};
 console.log(JSON.stringify({id,name:i.name,summary:i.visibleSummary,category:i.filterCategory,attributeCount:attrs.length,...delta}));
 displayed.push({id,attrs});
}
