import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={},tries=4):Promise<T>{let last:any;for(let i=0;i<tries;i++){try{return await client.call<T>(m,p)}catch(e){last=e;if(String(e).includes('fetch failed')){await new Promise(r=>setTimeout(r,1500));continue;}throw e;}}throw last;}
(async()=>{
  console.log('=== кандидаты по "Разъем RJ45" ===');
  const found:any[]=[];
  for(const ib of [24,26]){
    const res:any=await call('catalog.product.list',{filter:{iblockId:ib,'%name':'Разъем RJ45'},select:['id','name','iblockId'],order:{id:'ASC'}});
    for(const p of (res?.products||[])) found.push({id:Number(p.id),name:p.name,ib});
  }
  if(!found.length){ // запасной поиск
    for(const ib of [24,26]){const res:any=await call('catalog.product.list',{filter:{iblockId:ib,'%name':'RJ45'},select:['id','name'],order:{id:'ASC'}});for(const p of (res?.products||[])) if(/разъ[её]м|коннектор/i.test(String(p.name))) found.push({id:Number(p.id),name:p.name,ib});}
  }
  found.forEach(f=>console.log('  id='+f.id+' "'+f.name+'"'));
  // выбрать «5 / Cat 5» разъём
  const pick = found.find(f=>/(cat\.?\s*5|5[\s-]*ой|кат.*5)/i.test(f.name)) || found[0];
  if(!pick){console.log('разъём не найден');return;}
  console.log('\nВЫБРАН: id='+pick.id+' "'+pick.name+'"');
  const st:any=await call('catalog.storeproduct.list',{filter:{productId:pick.id},select:['storeId','amount']});
  console.log('остатки:'); (st?.storeProducts||[]).filter((s:any)=>Number(s.amount)>0).forEach((s:any)=>console.log('  склад '+s.storeId+': '+s.amount));
  const pr:any=await call('catalog.price.list',{filter:{productId:pick.id},select:['price','catalogGroupId']});
  const price=Number((pr?.prices||[]).find((x:any)=>Number(x.catalogGroupId)===2)?.price ?? (pr?.prices||[])[0]?.price ?? 0);
  console.log('цена BASE: '+price);
  console.log('\n=== правлю строку тест-сделки 36694 на разъём ===');
  await call('crm.deal.productrows.set',{id:36694,rows:[{PRODUCT_ID:pick.id,PRICE:price,QUANTITY:1}]});
  const rows:any=await call('crm.deal.productrows.get',{id:36694});
  (rows||[]).forEach((r:any)=>console.log('  строка: '+r.PRODUCT_NAME+' | TYPE='+r.TYPE+' | qty='+r.QUANTITY+' | price='+r.PRICE));
  console.log('\n>>> dealId=36694 product='+pick.id+' price='+price);
})().catch(e=>{console.error('FATAL',e instanceof B24ApiError?e.code+':'+(e.description??''):e)});
