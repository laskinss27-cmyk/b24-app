import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
function fields(label:string,r:any){if(!r){console.log(label+': —');return;} const o=r.shipment??r.order??r.basketItem??r.basketItems??r.payment??r; const ks=Array.isArray(o)?[]:Object.keys(o); console.log(label+' ('+ks.length+' полей): '+ks.slice(0,40).join(', '));}
(async()=>{
  console.log('=== доступность методов СОЗДАНИЯ (getfields = read-only) ===');
  fields('sale.order.getFields',       await tc('sale.order.getfields'));
  fields('sale.basketitem.getFields',  await tc('sale.basketitem.getfields'));
  fields('sale.shipment.getFields',    await tc('sale.shipment.getfields'));
  fields('sale.shipmentitem.getFields',await tc('sale.shipmentitem.getfields'));
  fields('sale.payment.getFields',     await tc('sale.payment.getfields'));
  console.log('\n=== методы удаления (для отката теста) — проверяем, что существуют (без вызова add) ===');
  // несуществующий id → ждём "не найдено", НЕ "method not found"
  await tc('sale.order.delete',{id:999999999});
  await tc('sale.shipment.delete',{id:999999999});
  console.log('\n=== персон-тайпы (нужен personTypeId для заказа) ===');
  const pt=await tc<any>('sale.persontype.list',{}); console.log(JSON.stringify(pt).slice(0,300));
})().catch(e=>{console.error('FATAL',e)});
