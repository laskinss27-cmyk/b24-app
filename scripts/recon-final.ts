import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>2200)s=s.slice(0,2200)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
(async()=>{
  console.log('=== ПОЛНЫЕ поля одной отгрузки (ищем хоть что-то про сделку/CRM) ===');
  const sh = await tc<{shipments?:any[]}>('sale.shipment.list',{select:['*'],order:{id:'DESC'}});
  const s0=(sh?.shipments||[])[0];
  if(s0){ const keys=Object.keys(s0); console.log('поля отгрузки ('+keys.length+'): '+keys.join(', ')); 
    const crmish=keys.filter(k=>/deal|crm|owner|entity|order/i.test(k)); j('crm-подобные поля', Object.fromEntries(crmish.map(k=>[k,s0[k]]))); }
  console.log('\n=== sale.shipment.getFields — вдруг есть поле сделки ===');
  const f=await tc<any>('sale.shipment.getFields',{}); if(f){const ks=Object.keys((f as any).shipment??f); console.log(ks.filter((k:string)=>/deal|crm|owner|entity|order/i.test(k)).join(', ')||'(нет crm/deal-полей)');}
  console.log('\n=== timeline bindings (для отгрузки как сущности?) ===');
  j('bindings.fields', await tc('crm.timeline.bindings.fields',{}));
  console.log('\n=== есть ли вообще crm-тип "order"/"realization" в crm.enum.ownertype ===');
  j('crm.enum.ownertype', await tc('crm.enum.ownertype',{}));
})().catch(e=>{console.error('FATAL',e)});
