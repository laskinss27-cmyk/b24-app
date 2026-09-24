import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isExcludedKit} from './scope.mjs';
const dir='catalog-audit-v2/progress';
const read=async name=>JSON.parse(await fs.readFile(`${dir}/${name}`,'utf8'));
const final=await read('stock-completeness-final.json');
const previous=await read('stock-completeness-latest.json');
const reviews=(await read('reviews.json')).reviews;
const progress=await read('progress.json');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const failures=[];
const check=(ok,message)=>{if(!ok)failures.push(message);};
const reports=[];
for(const file of (await fs.readdir(dir)).filter(x=>/^batch-\d+-applied\.json$/.test(x)).sort()){
 const batch=await read(file);
 check(batch.mode==='apply',`Invalid mode: ${file}`);
 for(const r of batch.reports){
  reports.push({...r,batch:batch.batch});
  check(r.verified===true,`Unverified write: ${r.itemCode}`);
  const i=final.items.find(x=>x.id===r.itemCode);
  check(Boolean(i),`Corrected item absent from current inventory: ${r.itemCode}`);
  if(!i)continue;
  check(same(i.content,JSON.parse(r.patch.b24_catalog_content)),`Content drift: ${r.itemCode}`);
  check(same(i.filterPayload,JSON.parse(r.patch.b24_filter_attributes)),`Filter drift: ${r.itemCode}`);
  check(i.filterCategory===r.patch.b24_filter_category,`Category drift: ${r.itemCode}`);
  check(i.filterSchemaVersion===r.patch.b24_filter_schema_version,`Schema drift: ${r.itemCode}`);
 }
}
const corrected=new Set(reports.map(x=>x.itemCode));
check(corrected.size===reports.length,'Duplicate corrected item');
const reviewed=new Set();
for(const r of reviews){
 const i=final.items.find(x=>x.id===r.id);
 check(Boolean(i),`Reviewed item absent: ${r.id}`);
 if(!i)continue;
 check(r.reviewedContentHash===createHash('sha256').update(JSON.stringify([i.visibleSummary,i.content])).digest('hex'),`Reviewed content drift: ${r.id}`);
 check(!corrected.has(r.id),`Review/write overlap: ${r.id}`);
 reviewed.add(r.id);
}
const inventoryIdentity=a=>a.items.map(x=>({id:x.id,stock:x.stockActual,warehouses:x.warehouses})).sort((a,b)=>a.id.localeCompare(b.id));
check(same(inventoryIdentity(previous),inventoryIdentity(final)),'Stock/inventory changed since preceding full inventory');
const unhandled=final.items.filter(x=>!isExcludedKit(x.name)&&!corrected.has(x.id)&&!reviewed.has(x.id));
check(!unhandled.length,`Unhandled current items: ${unhandled.map(x=>x.id).join(',')}`);
check(progress.inventoryAt===final.generatedAt,'Progress was not built from final inventory');
const current=reports.filter(x=>!isExcludedKit(x.name));
const result={generatedAt:new Date().toISOString(),inventoryAt:final.generatedAt,passed:!failures.length,counts:{inStock:final.items.length,excludedKits:final.items.filter(x=>isExcludedKit(x.name)).length,correctedStandalone:current.length,historicalKitWrites:reports.length-current.length,adequateWithoutWrite:reviews.filter(x=>x.status==='adequate_for_identity').length,needsIdentification:reviews.filter(x=>x.status==='needs_identification').length,unhandled:unhandled.length,verifiedBatches:new Set(reports.map(x=>x.batch)).size,correctedAttributes:current.reduce((s,r)=>s+r.attributes,0)},checks:{allAppliedReportsVerified:reports.every(x=>x.verified),currentContentAndFilterReadback:!failures.some(x=>/drift|absent/.test(x)),reviewContentHashes:!failures.some(x=>/Reviewed content drift/.test(x)),stockAndWarehouseQuantitiesUnchanged:same(inventoryIdentity(previous),inventoryIdentity(final)),allCurrentNonKitsHaveDecision:!unhandled.length},limitations:['36 cards require physical identification or exact technical documentation; their unknown parameters were not guessed.','Sufficient cards were read for completeness and obvious defects; independent manufacturer verification of every retained value is not claimed.','Three kit writes predate the user exclusion; kits were not subsequently changed.','Legacy accounting descriptions linked to historical documents were protected; catalog summaries and attributes are the updated display source.','Price values and document controls were checked immediately before/after every write; the final sweep reconfirms catalog content and stock, not a new global ledger audit.'],failures,needsIdentification:reviews.filter(x=>x.status==='needs_identification').map(({id,name,reason})=>({id,name,reason}))};
await fs.writeFile(`${dir}/final-verification.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(failures.length)process.exitCode=1;
