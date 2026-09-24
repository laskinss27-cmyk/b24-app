import {ErpClient} from '/app/packages/backend/dist/erp/client.js';
const erp=ErpClient.fromEnv();
if(!erp)throw new Error('ERPNext unavailable');
const settings=await erp.get('Stock Settings','Stock Settings');
const warehouses=await erp.list('Warehouse',['name','company','parent_warehouse','is_group','disabled'],[['disabled','=',0]],0);
const items=await erp.list('Item',['name','item_name','has_serial_no','has_batch_no','allow_negative_stock'],[['item_group','=','Каталог Б24'],['disabled','=',0],['is_stock_item','=',1]],0);
const draftRows=await erp.list('Delivery Note Item',['name','item_code','warehouse','qty'],[['docstatus','=',0]],3);
console.log(JSON.stringify({generatedAt:new Date().toISOString(),allowNegativeStock:settings?.allow_negative_stock,warehouses,serialItems:items.filter(x=>Number(x.has_serial_no)===1).length,batchItems:items.filter(x=>Number(x.has_batch_no)===1).length,itemNegativeStockOverrides:items.filter(x=>Number(x.allow_negative_stock)===1).length,draftRowShapes:draftRows.map(x=>Object.keys(x))}));
