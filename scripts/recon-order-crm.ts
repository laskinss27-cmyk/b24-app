import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>2000)s=s.slice(0,2000)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
(async()=>{
  console.log('=== sale.tradingplatform.list ===');
  j('platforms', await tc('sale.tradingplatform.list',{}));
  console.log('\n=== пробуем методы связи заказ↔CRM ===');
  j('crm.deal.productrows of 36178 ownerType', await tc('crm.deal.productrows.get',{id:36178}).then((r:any)=>Array.isArray(r)?r.length+' строк':r));
  // Известные методы привязки заказов к CRM в b24:
  await tc('sale.order.list',{filter:{'userId':22},select:['id','accountNumber','userId']});
  j('crm.item (тип 7 - старые заказы?)', await tc('crm.item.list',{entityTypeId:7,filter:{}}));
  // crm timeline binding для сделки
  j('crm.timeline.bindings.list', await tc('crm.timeline.bindings.list',{filter:{ENTITY_ID:36178,ENTITY_TYPE:'deal'}}));
  // прямой: есть ли у заказа метод получить связанную сделку
  j('crm.deal.contact.items.get 36178', await tc('crm.deal.contact.items.get',{id:36178}));
})().catch(e=>{console.error('FATAL',e)});
