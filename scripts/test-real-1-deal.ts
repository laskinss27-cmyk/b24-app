import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>1500)s=s.slice(0,1500)+'…';console.log(l+': '+s);}
async function call<T>(m:string,p:Record<string,unknown>={},tries=3):Promise<T>{
  let last:any; for(let i=0;i<tries;i++){try{return await client.call<T>(m,p)}catch(e){last=e; if(String(e).includes('fetch failed')){console.log('  …ретрай '+m+' ('+(i+1)+')'); await new Promise(r=>setTimeout(r,1500)); continue;} throw e;}} throw last;
}
(async()=>{
  console.log('=== ШАГ 1: ищу товар RJ45 (Cat 5) ===');
  let prod:any=null;
  for(const ib of [24,26]){
    const res:any = await call('catalog.product.list',{filter:{iblockId:ib,'%name':'RJ45'},select:['id','iblendId','name','iblockId'],order:{id:'ASC'}});
    for(const p of (res?.products||[])){ if(/RJ45.*5|5.*RJ45|Cat\s*5/i.test(String(p.name))){ prod={id:Number(p.id),name:p.name,iblockId:ib}; break; } }
    if(prod) break;
  }
  if(!prod){ console.log('НЕ нашёл RJ45 Cat5 — покажу что есть:'); const r:any=await call('catalog.product.list',{filter:{iblockId:24,'%name':'RJ45'},select:['id','name']}); (r?.products||[]).slice(0,10).forEach((p:any)=>console.log('  '+p.id+' '+p.name)); return; }
  console.log('товар: id='+prod.id+' "'+prod.name+'" (iblock '+prod.iblockId+')');
  const st:any = await call('catalog.storeproduct.list',{filter:{productId:prod.id},select:['storeId','amount']});
  console.log('остатки по складам:'); (st?.storeProducts||[]).forEach((s:any)=>console.log('  склад '+s.storeId+': '+s.amount));
  const pr:any = await call('catalog.price.list',{filter:{productId:prod.id},select:['productId','price','catalogGroupId']});
  const price = Number((pr?.prices||[]).find((x:any)=>Number(x.catalogGroupId)===2)?.price ?? (pr?.prices||[])[0]?.price ?? 100);
  console.log('цена (BASE): '+price);

  console.log('\n=== ШАГ 2: создаю ТЕСТОВУЮ сделку ===');
  const add:any = await call('crm.deal.add',{fields:{TITLE:'🧪 ТЕСТ реализации (удалить) — RJ45',CATEGORY_ID:0,ASSIGNED_BY_ID:1858,OPENED:'Y',COMMENTS:'Автотест проводки реализации. Можно удалять.'}});
  const dealId = Number(add);
  console.log('создана сделка ID='+dealId);
  await call('crm.deal.productrows.set',{id:dealId,rows:[{PRODUCT_ID:prod.id,PRICE:price,QUANTITY:1}]});
  console.log('добавлена строка: RJ45 ×1 по '+price);

  console.log('\n=== ШАГ 3: читаю созданное (проверь!) ===');
  const d:any = await call('crm.deal.get',{id:dealId});
  console.log('Сделка: ID='+d.ID+' | "'+d.TITLE+'" | стадия='+d.STAGE_ID+' | воронка='+d.CATEGORY_ID+' | ответственный='+d.ASSIGNED_BY_ID+' | сумма='+d.OPPORTUNITY);
  const rows:any = await call('crm.deal.productrows.get',{id:dealId});
  (rows||[]).forEach((r:any)=>console.log('  строка: '+r.PRODUCT_NAME+' | TYPE='+r.TYPE+' | qty='+r.QUANTITY+' | price='+r.PRICE));
  console.log('\n>>> dealId='+dealId+' product='+prod.id+' price='+price+' (запомни для следующего шага)');
})().catch(e=>{console.error('FATAL',e instanceof B24ApiError?e.code+':'+(e.description??''):e)});
