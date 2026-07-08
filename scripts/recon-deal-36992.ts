import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>6000)s=s.slice(0,6000)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{for(let i=0;i<4;i++){try{return await client.call<T>(m,p);}catch(e){if(e instanceof B24ApiError){console.log('  ⛔ '+m+' → '+e.code+':'+(e.description??''));return null;}await new Promise(r=>setTimeout(r,700));}}console.log('  ⛔ '+m+' → fetch failed x4');return null;}
const DID=36992;
(async()=>{
  console.log('======== СДЕЛКА',DID,'========');
  const d=await tc<Record<string,unknown>>('crm.deal.get',{id:DID});
  if(d){for(const k of ['ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CATEGORY_ID','OPPORTUNITY','IS_MANUAL_OPPORTUNITY','CLOSED','CLOSEDATE','CONTACT_ID']) console.log('  '+k+' =',d[k]);
    console.log('  KASSA оплачено (UF_CRM_1765984372) =',d['UF_CRM_1765984372']);
    console.log('  KASSA остаток  (UF_CRM_1765984397) =',d['UF_CRM_1765984397']);}

  console.log('\n======== ТОВАРНЫЕ СТРОКИ ========');
  const rows=await tc<Array<Record<string,unknown>>>('crm.deal.productrows.get',{id:DID})??[];
  let sum=0;
  for(const r of rows){const line=Number(r['PRICE']??0)*Number(r['QUANTITY']??0);sum+=line;
    console.log(`  ID=${r['ID']} TYPE=${r['TYPE']} PRODUCT_ID=${r['PRODUCT_ID']} "${String(r['PRODUCT_NAME']).slice(0,40)}" qty=${r['QUANTITY']} price=${r['PRICE']} STORE_ID=${r['STORE_ID']} → ${line}`);}
  console.log('  Σ строк =',sum,'| строк:',rows.length);

  console.log('\n======== ЗАКАЗ ========');
  const bnd=await tc<{orderEntity?:Array<Record<string,unknown>>}>('crm.orderentity.list',{filter:{ownerId:DID,ownerTypeId:2},select:['*']});
  j('orderEntity',bnd?.orderEntity);
  const oid=Number(bnd?.orderEntity?.[0]?.['orderId']??0);
  if(oid){
    const o=await tc<{order?:Record<string,unknown>}>('sale.order.get',{id:oid});
    const ord=o?.order??{};
    console.log('  order',oid,'price=',ord['price'],'payed=',ord['payed'],'deducted=',ord['deducted'],'statusId=',ord['statusId']);
    console.log('  -- basket --');
    for(const b of (ord['basketItems'] as Array<Record<string,unknown>>)??[]) console.log(`    id=${b['id']} productId=${b['productId']} "${String(b['name']).slice(0,35)}" qty=${b['quantity']} price=${b['price']} type=${b['type']} customPrice=${b['customPrice']} reserv=${JSON.stringify(b['reservations'])}`);
    console.log('  -- shipments --');
    j('shipments',(await tc<{shipments?:unknown}>('sale.shipment.list',{filter:{orderId:oid},select:['id','accountNumber','deducted','allowDelivery','deliveryId','statusId']}))?.shipments);
  } else console.log('  заказа НЕТ');

  console.log('\n======== ОСТАТКИ Б24-СКЛАД по товарам ========');
  const ids=[...new Set(rows.filter(r=>Number(r['TYPE'])!==7&&Number(r['PRODUCT_ID'])>0).map(r=>Number(r['PRODUCT_ID'])))];
  for(const id of ids) j('product '+id,(await tc<{storeProducts?:unknown}>('catalog.storeproduct.list',{filter:{productId:id},select:['storeId','amount','quantityReserved']}))?.storeProducts);
})().catch(e=>console.error('FATAL',e));
