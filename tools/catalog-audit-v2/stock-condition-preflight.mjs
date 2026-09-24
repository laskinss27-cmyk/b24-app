import {ErpClient} from '/app/packages/backend/dist/erp/client.js';
const erp=ErpClient.fromEnv();if(!erp)throw Error('ERP unavailable');
const settings=await erp.get('Stock Settings','Stock Settings');
const fields=[];
for(const name of ['Stock Entry-b24_condition_operation','Stock Entry-b24_condition_details','Warehouse-b24_condition_base','Warehouse-b24_stock_condition']){
 const field=await erp.get('Custom Field',name);fields.push({name,present:Boolean(field)});
}
const warehouses=await erp.list('Warehouse',['name','warehouse_name','is_group','disabled'],[['warehouse_name','like','%Состояние:%']],0);
const negativeAllowed=Number(settings?.allow_negative_stock??1)!==0;
if(negativeAllowed)throw Error('Negative stock is allowed; condition changes would be blocked');
process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),summary:{negativeStockAllowed:negativeAllowed,fields,conditionWarehouses:warehouses.length},warehouses}));
