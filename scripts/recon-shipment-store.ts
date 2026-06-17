import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>2000)s=s.slice(0,2000)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
(async()=>{
  console.log('=== позиции отгрузки 1432 (sale.shipmentitem.list) ===');
  const si:any=await tc('sale.shipmentitem.list',{filter:{orderDeliveryId:1432},select:['*']});
  j('shipmentItems', si);
  const items = si?.shipmentItems || si?.result || [];
  const siId = items[0]?.id;
  console.log('\n=== привязка позиции к складу (пробую методы) ===');
  j('sale.shipmentitemstore.list (по shipmentItem '+siId+')', await tc('sale.shipmentitemstore.list',{filter:{orderDeliveryBasketId:siId}}));
  j('sale.shipmentitemstore.getfields', await tc('sale.shipmentitemstore.getfields',{}));
  j('sale.shipmentitemstore.list (без фильтра, первые)', await tc('sale.shipmentitemstore.list',{}));
  console.log('\n=== резерв в корзине? (sale.basketitem 558) ===');
  j('basket 558', await tc('sale.basketitem.list',{filter:{orderId:558},select:['id','productId','quantity','reserveQuantity']}));
})().catch(e=>console.error('FATAL',e instanceof B24ApiError?e.code+':'+(e.description??''):e));
