import {createHash} from 'node:crypto';
import {ErpClient} from '/app/packages/backend/dist/erp/client.js';
import {parseCatalogContent,renderCatalogDescription,serializeFilterAttributes} from '/app/packages/backend/dist/catalog-content.js';
const erp=ErpClient.fromEnv();
if(!erp)throw Error('ERP unavailable');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const same=(a,b)=>hash(a)===hash(b);
const business=v=>Array.isArray(v)?v.map(business):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['modified','modified_by'].includes(k)).map(([k,v])=>[k,business(v)])):v;
const controls=async id=>({
 bins:await erp.list('Bin',['*'],[['item_code','=',id]],0,'name asc'),
 prices:await erp.list('Item Price',['*'],[['item_code','=',id]],0,'name asc'),
});
const input=globalThis.__CLEANUP_INPUT__;
const records=[];
if(input.mode==='backup'){
 for(let offset=0;offset<input.candidates.length;offset+=5){
  records.push(...await Promise.all(input.candidates.slice(offset,offset+5).map(async c=>{
   const item=await erp.get('Item',c.id);
   if(!item||String(item.modified)!==c.modified||!same(parseCatalogContent(item.b24_catalog_content)??null,c.beforeContent))throw Error(`Catalog changed: ${c.id}`);
   const control=await controls(c.id);
   if(Number(item.disabled)!==0||Number(item.is_stock_item)!==1||control.bins.reduce((s,b)=>s+Number(b.actual_qty),0)<=0)throw Error(`Out of scope: ${c.id}`);
   const content=c.afterContent??{version:1,summary:c.descriptionAfter??'',attributes:[]};
   const patch={b24_catalog_content:JSON.stringify(content),b24_filter_attributes:serializeFilterAttributes(content,String(item.b24_filter_category??'')),description:renderCatalogDescription(content).replaceAll('&','&amp;').replaceAll('>','&gt;')};
   return {id:c.id,item,control,patch};
  })));
  process.stderr.write(JSON.stringify({event:'backup',done:records.length,total:input.candidates.length})+'\n');
 }
 process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),mode:'backup',proposalHash:input.proposalHash,records}));
}else if(input.mode==='apply'||input.mode==='verify'){
 for(const saved of input.records){
  const {id,patch}=saved;
  if(!/^\d+$/.test(id)||Object.keys(patch).sort().join(',')!=='b24_catalog_content,b24_filter_attributes,description')throw Error('Invalid patch scope');
  const current=await erp.get('Item',id);
  const control=await controls(id);
  const applied=Object.entries(patch).every(([key,v])=>String(current?.[key]??'')===v);
  const expectedItem={...saved.item,...patch};
  const expectedControl={...saved.control,prices:saved.control.prices.map(p=>({...p,item_description:patch.description}))};
  if(applied){
   if(!same(business(current),business(expectedItem))||!same(business(control),business(expectedControl)))throw Error(`Existing write/control drift: ${id}`);
  }else{
   if(input.mode==='verify')throw Error(`Not applied: ${id}`);
   if(!same(current,saved.item)||!same(control,saved.control))throw Error(`Concurrent change: ${id}`);
   if(control.bins.reduce((s,b)=>s+Number(b.actual_qty),0)<=0)throw Error(`No stock: ${id}`);
   process.stderr.write(JSON.stringify({event:'before-write',id})+'\n');
   await erp.update('Item',id,patch);
   const after=await erp.get('Item',id),afterControl=await controls(id);
   for(const [key,v] of Object.entries(patch))if(String(after?.[key]??'')!==v)throw Error(`Readback mismatch ${id}:${key}`);
   if(!same(business(after),business(expectedItem)))throw Error(`Unexpected Item change: ${id}`);
   if(!same(business(afterControl),business(expectedControl)))throw Error(`Unexpected stock/price change: ${id}`);
  }
  records.push({id,verified:true,alreadyApplied:applied,patchHash:hash(patch)});
  process.stderr.write(JSON.stringify({event:'verified',id,done:records.length,total:input.records.length})+'\n');
 }
 process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),mode:input.mode,proposalHash:input.proposalHash,records}));
}else throw Error('Invalid mode');
