import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={},tries=4):Promise<T>{let last:any;for(let i=0;i<tries;i++){try{return await client.call<T>(m,p)}catch(e){last=e;if(String(e).includes('fetch failed')){await new Promise(r=>setTimeout(r,1500));continue;}throw e;}}throw last;}
(async()=>{
  const ds:any=await call('crm.deal.list',{filter:{'>=ID':36690},select:['ID','TITLE','ASSIGNED_BY_ID','CREATED_BY_ID','DATE_CREATE','OPPORTUNITY','CATEGORY_ID','STAGE_ID','CONTACT_ID'],order:{ID:'ASC'}});
  console.log('сделки с ID>=36690 ('+ds.length+'):');
  for(const d of ds){
    let prod='';
    try{const r:any=await call('crm.deal.productrows.get',{id:d.ID}); prod=(r||[]).map((x:any)=>String(x.PRODUCT_NAME).slice(0,25)+'×'+x.QUANTITY).join('; ');}catch{}
    console.log(`  #${d.ID} | "${d.TITLE}" | created=${d.DATE_CREATE} | by=${d.CREATED_BY_ID} assigned=${d.ASSIGNED_BY_ID} | sum=${d.OPPORTUNITY} | cat=${d.CATEGORY_ID} | contact=${d.CONTACT_ID} | [${prod||'нет строк'}]`);
  }
})().catch(e=>console.error('FATAL',e instanceof B24ApiError?e.code+':'+(e.description??''):e));
