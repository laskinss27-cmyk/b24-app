import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={},tries=4):Promise<T>{let last:any;for(let i=0;i<tries;i++){try{return await client.call<T>(m,p)}catch(e){last=e;if(String(e).includes('fetch failed')){await new Promise(r=>setTimeout(r,1500));continue;}throw e;}}throw last;}
(async()=>{
  const PID=17130, DEAL=36694;
  const g:any=await call('catalog.product.get',{id:PID});
  console.log('товар: id='+PID+' "'+(g?.product?.name)+'"');
  const pr:any=await call('catalog.price.list',{filter:{productId:PID},select:['price','catalogGroupId']});
  const price=Number((pr?.prices||[]).find((x:any)=>Number(x.catalogGroupId)===2)?.price ?? (pr?.prices||[])[0]?.price ?? 0);
  console.log('цена BASE: '+price);
  const st:any=await call('catalog.storeproduct.list',{filter:{productId:PID},select:['storeId','amount']});
  console.log('остатки (где >0):'); (st?.storeProducts||[]).filter((s:any)=>Number(s.amount)>0).forEach((s:any)=>console.log('  склад '+s.storeId+': '+s.amount));
  console.log('\n=== ставлю строку тест-сделки '+DEAL+' на 17130 ×1 ===');
  await call('crm.deal.productrows.set',{id:DEAL,rows:[{PRODUCT_ID:PID,PRICE:price,QUANTITY:1}]});
  const rows:any=await call('crm.deal.productrows.get',{id:DEAL});
  (rows||[]).forEach((r:any)=>console.log('  строка: '+r.PRODUCT_NAME+' | TYPE='+r.TYPE+' | qty='+r.QUANTITY+' | price='+r.PRICE+' | STORE_ID='+r.STORE_ID));
  const d:any=await call('crm.deal.get',{id:DEAL});
  console.log('\nСделка '+DEAL+': "'+d.TITLE+'" | сумма='+d.OPPORTUNITY+' | ответственный='+d.ASSIGNED_BY_ID);
})().catch(e=>{console.error('FATAL',e instanceof B24ApiError?e.code+':'+(e.description??''):e)});
