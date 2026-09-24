import { createHash } from 'node:crypto';
import { ErpClient } from '/app/packages/backend/dist/erp/client.js';
import { loadDatabaseConfig } from '/app/packages/backend/dist/database/config.js';
import { createDatabaseRuntime } from '/app/packages/backend/dist/database/runtime.js';
import { buildSqlProductBase } from '/app/packages/backend/dist/catalog-mirror/product-base.js';
const erp=ErpClient.fromEnv(); if(!erp) throw Error('ERP unavailable');
const after=process.argv.includes('--after');
const runtime=createDatabaseRuntime(loadDatabaseConfig());
try{
 const plan=await runtime.readLatestCatalogMirrorPlan();if(!plan)throw Error('Catalog checkpoint unavailable');
 const matches=buildSqlProductBase(plan).data.rows.filter(r=>r.name.trim().toLocaleLowerCase('ru-RU')==='расходные материалы').map(r=>({id:r.id,name:r.name,isService:r.isService}));
 if(after&&(matches.length!==1||matches[0].id!==18612))throw Error('Catalog consolidation not confirmed');
 const controls=[];
 for(const id of ['18612','9254']){
  const item=await erp.get('Item',id);
  const control={id,item:{name:item.name,item_name:item.item_name,is_stock_item:item.is_stock_item,disabled:item.disabled,valuation_rate:item.valuation_rate},tables:{}};
  for(const [dt,fields] of [['Bin',['name','warehouse','actual_qty','valuation_rate','stock_value']],['Item Price',['name','price_list','price_list_rate']],['Sales Order Item',['name']],['Delivery Note Item',['name']],['Purchase Receipt Item',['name']],['Stock Entry Detail',['name']]]){
   control.tables[dt]=(await erp.list(dt,fields,[['item_code','=',id]],0)).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  }
  controls.push(control);
 }
 let priceChecks=[];
 if(after){
  const {dealLinePurchasingPrice}=await import('/app/packages/shared/dist/index.js');
  priceChecks=[10000,9000,0,123.45].map(sale=>({sale,purchase:dealLinePurchasingPrice(18612,sale,100),profit:(sale-dealLinePurchasingPrice(18612,sale,100))*2}));
  if(priceChecks.some(r=>r.purchase!==r.sale||r.profit!==0))throw Error('Pass-through cost check failed');
 }
 const erpControlHash=createHash('sha256').update(JSON.stringify(controls)).digest('hex');
 process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),summary:{after,catalogMatches:matches,erpControlHash,priceChecks},controls}));
}finally{await runtime.close();}
