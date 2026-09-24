// SPEC and APPLY are injected by the local runner after validating the saved backup.
import { createHash } from 'node:crypto';
import { ErpClient } from '/app/packages/backend/dist/erp/client.js';
import { createCatalogContent, renderCatalogDescription, serializeFilterAttributes } from '/app/packages/backend/dist/catalog-content.js';
const erp=ErpClient.fromEnv();
if(!erp) throw new Error('ERPNext unavailable');
const canonical=(v)=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const business=(v)=>Array.isArray(v)?v.map(business):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['modified','modified_by'].includes(k)).map(([k,x])=>[k,business(x)])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const snapshotControl=async(code,types)=>{
  const out={};
  for(const type of types) out[type]=await erp.list(type,['*'],[['item_code','=',code]],0,'name asc');
  return out;
};
// ERPNext synchronizes Item.description to the descriptive field of Item Price.
// Accept only that exact text update; every price amount and other control field stays exact.
const expectedControl=(control,patch)=>{
  if(!Object.hasOwn(patch,'description'))return control;
  return {...control,'Item Price':control['Item Price'].map(row=>({...row,item_description:patch.description}))};
};
const candidates=[];
// Preflight every target before writing any card.
for(const spec of SPEC.items){
  const current=await erp.get('Item',spec.itemCode);
  if(/(?:^|[^а-яёa-z])(?:комплект(?:ы|а|ов)?|набор(?:ы|а|ов)?|kit|bundle)(?:$|[^а-яёa-z])/iu.test(current.item_name))throw new Error(`Kit excluded by user: ${spec.itemCode}`);
  const control=await snapshotControl(spec.itemCode,Object.keys(spec.before.control));
  if(control.Bin.reduce((sum,b)=>sum+Number(b.actual_qty),0)<=0) throw new Error(`No stock: ${spec.itemCode}`);
  const protectedDescription=Object.entries(control).some(([type,rows])=>!['Bin','Item Price','Stock Ledger Entry'].includes(type)&&rows.length);
  const content=createCatalogContent(spec.summary,spec.attributes);
  if(content.attributes.length!==spec.attributes.length) throw new Error('Lost attributes');
  const patch={b24_catalog_content:JSON.stringify(content),b24_filter_category:spec.category,b24_filter_attributes:serializeFilterAttributes(content,spec.category),b24_filter_schema_version:'1'};
  // Frappe's Text Editor sanitizer encodes a literal greater-than sign even in
  // plain text. Predict that exact representation; keep readback equality strict.
  // Confirmed by batch-028-checkpoint: only ">" -> "&gt;", no other field changed.
  // Batch 036 readback additionally confirmed literal ampersand -> &amp;.
  // Encode ampersands first so generated entities are not double-encoded.
  if(!protectedDescription)patch.description=renderCatalogDescription(content).replaceAll('&','&amp;').replaceAll('>','&gt;');
  const alreadyApplied=Object.entries(patch).every(([key,value])=>String(current[key]??'')===String(value));
  const baselineControl=spec.before.control;
  const expectedAfterControl=expectedControl(baselineControl,patch);
  if(hash(control)!==spec.before.controlHash && !(alreadyApplied && same(control,expectedAfterControl)))throw new Error(`Control changed since backup: ${spec.itemCode}; refresh backup`);
  if(!same(current,spec.before.item)){
    const expected={...spec.before.item,...patch};
    if(!alreadyApplied||!same(business(current),business(expected)))throw new Error(`Item changed since backup: ${spec.itemCode}`);
  }
  candidates.push({spec,current,control,content,patch,protectedDescription,alreadyApplied,expectedAfterControl});
}
const reports=[];
for(const {spec,current,control,content,patch,protectedDescription,alreadyApplied,expectedAfterControl} of candidates){
  const report={itemCode:spec.itemCode,name:current.item_name,stock:control.Bin.reduce((sum,b)=>sum+Number(b.actual_qty),0),protectedDescription,attributes:content.attributes.length,patch,sources:spec.sources,unresolved:spec.unresolved,verified:false};
  if(APPLY && alreadyApplied){
    report.verified=true;report.alreadyApplied=true;report.savedModified=current.modified;report.controlHash=hash(control);
    process.stderr.write(JSON.stringify({event:'verified-existing',itemCode:spec.itemCode,controlHash:report.controlHash})+'\n');
  }else if(APPLY){
    // Recheck just before the write, including real stock and historical documents.
    const fresh=await erp.get('Item',spec.itemCode);
    if(!same(fresh,current))throw new Error(`Concurrent item change: ${spec.itemCode}`);
    const freshControl=await snapshotControl(spec.itemCode,Object.keys(control));
    if(!same(freshControl,control))throw new Error(`Concurrent stock/document change: ${spec.itemCode}`);
    process.stderr.write(JSON.stringify({event:'before-write',itemCode:spec.itemCode,at:new Date().toISOString()})+'\n');
    await erp.update('Item',spec.itemCode,patch);
    const after=await erp.get('Item',spec.itemCode);
    for(const [key,value] of Object.entries(patch))if(String(after[key]??'')!==String(value))throw new Error(`Readback mismatch ${spec.itemCode}:${key}`);
    const allowed=new Set([...Object.keys(patch),'modified','modified_by']);
    for(const key of new Set([...Object.keys(current),...Object.keys(after)]))if(!allowed.has(key)&&!same(business(current[key]),business(after[key])))throw new Error(`Unexpected field change ${spec.itemCode}:${key}`);
    const afterControl=await snapshotControl(spec.itemCode,Object.keys(control));
    if(!same(afterControl,expectedAfterControl))throw new Error(`Control mismatch after ${spec.itemCode}; stop and investigate`);
    report.verified=true;report.savedModified=after.modified;report.controlHash=hash(afterControl);
    process.stderr.write(JSON.stringify({event:'verified',itemCode:spec.itemCode,modified:after.modified,controlHash:report.controlHash})+'\n');
  }
  report.priceDescriptionSynchronized=Boolean(APPLY && patch.description && control['Item Price'].length);
  reports.push(report);
}
process.stdout.write(JSON.stringify({mode:APPLY?'apply':'dry-run',batch:SPEC.batch,generatedAt:new Date().toISOString(),reports}));
