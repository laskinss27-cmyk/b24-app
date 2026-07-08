import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function getRetry(id:number,n=4):Promise<Record<string,unknown>|null>{for(let i=0;i<n;i++){try{return await client.call('crm.deal.get',{id});}catch(e){console.log('  retry',i+1,String(e).slice(0,60));await new Promise(r=>setTimeout(r,800));}}return null;}
(async()=>{
  const d = await getRetry(36922);
  if(!d){console.log('не прочитал');return;}
  const keys=['ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CATEGORY_ID','OPPORTUNITY','IS_MANUAL_OPPORTUNITY','CLOSED','CLOSEDATE','CONTACT_ID','COMPANY_ID'];
  for(const k of keys) console.log('  '+k+' =',d[k]);
  console.log('  KASSA оплачено (UF_CRM_1765984372) =',d['UF_CRM_1765984372']);
  console.log('  KASSA остаток  (UF_CRM_1765984397) =',d['UF_CRM_1765984397']);
})().catch(e=>console.error('FATAL',e));
