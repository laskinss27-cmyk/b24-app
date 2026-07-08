import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{for(let i=0;i<4;i++){try{return await client.call<T>(m,p);}catch(e){if(e instanceof B24ApiError){console.log('  ⛔ '+m+' → '+e.code+':'+(e.description??''));return null;}await new Promise(r=>setTimeout(r,700));}}return null;}
const DID=37004;
(async()=>{
  console.log('======== Б24 СДЕЛКА',DID,'========');
  const d=await tc<Record<string,unknown>>('crm.deal.get',{id:DID});
  if(d) for(const k of ['TITLE','STAGE_ID','STAGE_SEMANTIC_ID','OPPORTUNITY','IS_MANUAL_OPPORTUNITY','CLOSED']) console.log('  '+k+' =',d[k]);
  if(d){console.log('  KASSA оплачено =',d['UF_CRM_1765984372'],'| остаток =',d['UF_CRM_1765984397']);}
  console.log('\n-- строки сделки Б24 (должна быть одна «Выезд инженера») --');
  const rows=await tc<Array<Record<string,unknown>>>('crm.deal.productrows.get',{id:DID})??[];
  for(const r of rows) console.log(`  TYPE=${r['TYPE']} PRODUCT_ID=${r['PRODUCT_ID']} "${r['PRODUCT_NAME']}" qty=${r['QUANTITY']} price=${r['PRICE']}`);
  console.log('  Σ Б24 =',rows.reduce((a,r)=>a+Number(r['PRICE']??0)*Number(r['QUANTITY']??0),0));
})().catch(e=>console.error(e));
