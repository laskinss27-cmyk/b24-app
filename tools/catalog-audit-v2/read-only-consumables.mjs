import {ErpClient} from '/app/packages/backend/dist/erp/client.js';
import {B24Client} from '/app/packages/backend/dist/b24/client.js';
const erp=ErpClient.fromEnv();if(!erp)throw Error('ERP unavailable');
const webhook=process.env.CATALOG_WRITE_WEBHOOK??process.env.DEV_WEBHOOK;
if(!webhook)throw Error('Catalog connection unavailable');
const b24=new B24Client({auth:{kind:'webhook',url:webhook}});
const matches=await erp.list('Item',['name','item_name','is_stock_item','disabled','item_group','b24_product_status','modified'],[['item_name','like','%расход%']],0);
const b24Matches=[];
for(const iblockId of [24,26]){
 const response=await b24.call('catalog.product.list',{filter:{iblockId,'%name':'расход'},select:['id','name','active','iblockId','type','purchasingPrice','quantity']});
 b24Matches.push(...(response.products??[]));
}
const items=[];
for(const item of matches){
 const control={};
 for(const dt of ['Bin','Item Price','Sales Order Item','Delivery Note Item','Sales Invoice Item','Purchase Receipt Item','Stock Entry Detail']){
  const rows=await erp.list(dt,dt==='Bin'||dt==='Item Price'?['*']:['name'],[['item_code','=',item.name]],0);
  control[dt]=dt==='Bin'||dt==='Item Price'?rows:{count:rows.length,sample:rows.slice(0,5)};
 }
 items.push({item,control});
}
process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),summary:{erpCandidates:items.length,bitrixCandidates:b24Matches.length},items,b24Matches}));
