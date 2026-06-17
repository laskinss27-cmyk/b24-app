import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>1800)s=s.slice(0,1800)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
(async()=>{
  console.log('=== crm.item.delivery.list (доставки/отгрузки сделок) ===');
  j('deliveries', await tc('crm.item.delivery.list',{}));
  console.log('\n=== crm.item.payment.list (оплаты сделок) ===');
  j('payments', await tc('crm.item.payment.list',{}));
  console.log('\n=== поля доставки (есть ли ownerId сделки + orderId/shipmentId) ===');
  j('delivery.fields', await tc('crm.item.delivery.fields',{}));
})().catch(e=>{console.error('FATAL',e)});
