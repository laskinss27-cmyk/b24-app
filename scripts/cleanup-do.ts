import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={},tries=5):Promise<T>{let last:any;for(let i=0;i<tries;i++){try{return await client.call<T>(m,p)}catch(e){last=e;if(String(e).includes('fetch failed')){await new Promise(r=>setTimeout(r,1500));continue;}throw e;}}throw last;}
const DEALS=[36694,36696,36698,36700,36702];
const CONTACTS=[16282,16284,16286,16288];
(async()=>{
  console.log('=== контакты-кандидаты (проверка, что пустышки) ===');
  for(const c of CONTACTS){try{const r:any=await call('crm.contact.get',{id:c});console.log(`  #${c}: "${r.NAME||''} ${r.LAST_NAME||''}".trim() created=${r.DATE_CREATE} by=${r.CREATED_BY_ID}`);}catch(e){console.log('  #'+c+': '+(e instanceof B24ApiError?e.code:e));}}
  console.log('\n=== удаляю СДЕЛКИ ===');
  for(const d of DEALS){try{await call('crm.deal.delete',{id:d});console.log('  удалена сделка '+d);}catch(e){console.log('  ⚠ сделка '+d+': '+(e instanceof B24ApiError?e.code+':'+e.description:e));}}
  console.log('\n=== удаляю КОНТАКТЫ ===');
  for(const c of CONTACTS){try{await call('crm.contact.delete',{id:c});console.log('  удалён контакт '+c);}catch(e){console.log('  ⚠ контакт '+c+': '+(e instanceof B24ApiError?e.code+':'+e.description:e));}}
  console.log('\n=== проверка: заказы 896/898/900/902 (должны отсутствовать) ===');
  for(const o of [896,898,900,902]){const r:any=await call('sale.order.list',{filter:{id:o},select:['id']});console.log('  заказ '+o+': '+((r?.orders||[]).length?'ЕСТЬ ❗':'нет ✅'));}
  console.log('\n=== контроль: сделки с ID>=36690 ===');
  const ds:any=await call('crm.deal.list',{filter:{'>=ID':36690},select:['ID','TITLE','ASSIGNED_BY_ID'],order:{ID:'ASC'}});
  for(const d of ds) console.log('  #'+d.ID+' "'+d.TITLE+'" assigned='+d.ASSIGNED_BY_ID);
})().catch(e=>console.error('FATAL',e instanceof B24ApiError?e.code+':'+(e.description??''):e));
