import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p);}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+e.description:String(e)));return null;}}
(async()=>{
  console.log('=== поле docType (типы складских документов) ===');
  const f = await tc<Record<string,any>>('catalog.document.fields');
  // fields приходит массивом-объектом; ищем docType
  const dt = (f as any)?.docType ?? (Array.isArray(f)?undefined:(f as any));
  console.log('  docType field:', JSON.stringify((f as any)?.docType ?? 'см ниже').slice(0,400));
  // на всякий — весь список ключей полей
  if(f && !Array.isArray(f)) console.log('  поля документа:', Object.keys(f).join(', '));

  console.log('\n=== последние 5 складских документов (что реально используется) ===');
  const docs = await tc<{documents?:any[]}>('catalog.document.list',{select:['id','docType','status','total','currency','dateDocument','createdBy','commentary'],order:{id:'DESC'},filter:{}});
  for(const d of (docs?.documents??[]).slice(0,8)) console.log(`  doc#${d.id} type=${d.docType} status=${d.status} total=${d.total} date=${d.dateDocument} by=${d.createdBy} "${(d.commentary??'').slice(0,30)}"`);

  console.log('\n=== позиции последнего проведённого документа ===');
  const last = (docs?.documents??[])[0];
  if(last){
    const el = await tc<{documentElements?:any[]}>('catalog.document.element.list',{filter:{docId:last.id},select:['id','docId','storeFrom','storeTo','elementId','amount','purchasingPrice']});
    for(const e of (el?.documentElements??[]).slice(0,10)) console.log(`  el#${e.id} elementId=${e.elementId} storeFrom=${e.storeFrom} storeTo=${e.storeTo} amount=${e.amount} price=${e.purchasingPrice}`);
  }
})().catch(e=>console.error('FATAL',e));
