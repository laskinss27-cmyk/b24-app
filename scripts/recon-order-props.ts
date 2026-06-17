import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>3000)s=s.slice(0,3000)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
(async()=>{
  console.log('=== определения свойств заказа (sale.property.list) ===');
  const defs = await tc<{properties?:any[]}>('sale.property.list',{filter:{}});
  const pl = defs?.properties ?? [];
  for(const p of pl) console.log('  id='+p.id+' code='+p.code+' name='+JSON.stringify(p.name)+' type='+p.type);
  console.log('\n=== значения свойств заказа 890 (sale.propertyvalue.list) ===');
  j('order 890 props', await tc('sale.propertyvalue.list',{filter:{orderId:890}}));
  console.log('\n=== значения свойств заказа 558 ===');
  j('order 558 props', await tc('sale.propertyvalue.list',{filter:{orderId:558}}));
  console.log('\n=== пробуем crm-binding напрямую ===');
  await tc('crm.deal.list',{filter:{},select:['ID']}); // sanity
  j('sale.tradingPlatform.list', await tc('sale.tradingplatform.list',{}));
})().catch(e=>{console.error('FATAL',e)});
