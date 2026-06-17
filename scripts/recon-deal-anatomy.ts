import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>2200)s=s.slice(0,2200)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
(async()=>{
  // 1) найти выигранную сделку С ТОВАРАМИ и складом (кандидат-эталон)
  console.log('=== ищу выигранную сделку с товарными строками ===');
  const won = await tc<Array<Record<string,unknown>>>('crm.deal.list',{filter:{STAGE_SEMANTIC_ID:'S'},select:['ID','TITLE','CONTACT_ID','COMPANY_ID','CATEGORY_ID'],order:{ID:'DESC'}}) ?? [];
  let ref:any=null;
  for(const d of won.slice(0,25)){
    const rows = await tc<any[]>('crm.deal.productrows.get',{id:d['ID']}) ?? [];
    const goods = rows.filter((r:any)=>Number(r['TYPE'])!==7 && Number(r['STORE_ID'])>0 && Number(r['PRODUCT_ID'])>0);
    if(goods.length){ ref={deal:d,goods,allRows:rows.length}; break; }
  }
  if(!ref){console.log('не нашёл сделку с товаром+складом в выборке');}
  else{
    console.log('ЭТАЛОН: сделка', ref.deal.ID, '|', String(ref.deal.TITLE).slice(0,40), '| CONTACT_ID=', ref.deal.CONTACT_ID, '| COMPANY_ID=', ref.deal.COMPANY_ID, '| CAT=', ref.deal.CATEGORY_ID);
    for(const g of ref.goods) console.log('  товар: PRODUCT_ID='+g.PRODUCT_ID+' qty='+g.QUANTITY+' price='+g.PRICE+' STORE_ID='+g.STORE_ID+' "'+String(g.PRODUCT_NAME).slice(0,30)+'"');
    // склад-кандидат и текущий остаток первого товара
    const g0=ref.goods[0];
    j('остаток товара '+g0.PRODUCT_ID+' по складам', await tc('catalog.storeproduct.list',{filter:{productId:Number(g0.PRODUCT_ID)},select:['storeId','amount','quantityReserved']}));
  }
  // 2) шаблон: как устроена УЖЕ существующая реализация (заказ+отгрузка)
  console.log('\n=== шаблон существующей реализации: заказ 558 + его отгрузки ===');
  j('order 558', await tc('sale.order.list',{filter:{id:558},select:['*']}));
  j('shipments заказа 558', await tc('sale.shipment.list',{filter:{orderId:558},select:['*']}));
  j('basket заказа 558', await tc('sale.basketitem.list',{filter:{orderId:558},select:['productId','quantity','price','type','name']}));
  console.log('\n=== службы доставки (deliveryId для отгрузки) ===');
  j('delivery services', await tc('sale.delivery.getlist',{}) ?? await tc('sale.delivery.list',{}));
})().catch(e=>{console.error('FATAL',e)});
