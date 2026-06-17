import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await c.call<T>(m,p);}catch(e){console.log(`  ⛔ ${m} → ${e instanceof B24ApiError?e.code+': '+e.description:String(e)}`);return null;}}
async function main(){
  console.log('=== crm.deal.productrows.fields (склад/скидка) ===');
  const prf = await call<Record<string,unknown>>('crm.deal.productrows.fields');
  console.log(Object.keys(prf??{}).join(', '));
  for(const k of Object.keys(prf??{})) if(/store|discount|price|tax|measure/i.test(k)) console.log(`   ${k}:`, JSON.stringify((prf as any)[k]).slice(0,120));

  console.log('\n=== crm.deal.fields — поля со складом/скидкой ===');
  const df = await call<Record<string,unknown>>('crm.deal.fields');
  for(const k of Object.keys(df??{})) if(/store|warehouse|склад|discount|скидк/i.test(k+' '+JSON.stringify((df as any)[k]?.title??''))) console.log(`   ${k}: ${JSON.stringify((df as any)[k]?.title)}`);

  console.log('\n=== «Розничный покупатель» — контакт? ===');
  const cont = await call<Array<Record<string,unknown>>>('crm.contact.list',{ filter:{'%NAME':'Розничн'}, select:['ID','NAME','LAST_NAME'] });
  console.log('contacts:', JSON.stringify(cont));
  console.log('=== компания? ===');
  const comp = await call<Array<Record<string,unknown>>>('crm.company.list',{ filter:{'%TITLE':'Розничн'}, select:['ID','TITLE'] });
  console.log('companies:', JSON.stringify(comp));

  console.log('\n=== crm.productrow.fields (универсальные строки — скидка) ===');
  const urf = await call<Record<string,unknown>>('crm.productrow.fields');
  for(const k of Object.keys(urf??{})) if(/discount/i.test(k)) console.log(`   ${k}:`, JSON.stringify((urf as any)[k]).slice(0,140));
}
main().catch(e=>{console.error(e);process.exit(1);});
