import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={}):Promise<T>{return c.call<T>(m,p);}
async function main(){
  // userfield склада?
  const uf = await call<Array<Record<string,unknown>>>('crm.deal.userfield.list',{});
  const storeUf = (uf??[]).filter(f=>/store|склад|warehouse/i.test(JSON.stringify(f.FIELD_NAME)+JSON.stringify(f.EDIT_FORM_LABEL)));
  console.log('UF склада на сделке:', JSON.stringify(storeUf.map(f=>({name:f.FIELD_NAME,label:f.EDIT_FORM_LABEL}))));

  const dealId = await call<number>('crm.deal.add',{ fields:{ TITLE:'ТЕСТ store+discount (удалится)', CATEGORY_ID:6, STAGE_ID:'C6:NEW' } });
  console.log('сделка', dealId);
  await call('crm.deal.productrows.set',{ id:dealId, rows:[
    { PRODUCT_ID:1924, PRICE:35000, QUANTITY:2, STORE_ID:8, DISCOUNT_TYPE_ID:2, DISCOUNT_RATE:10 },
  ]});
  const rows = await call<Array<Record<string,unknown>>>('crm.deal.productrows.get',{ id:dealId });
  console.log('строки назад:');
  for(const r of rows) console.log('  ', JSON.stringify(r));
  await call('crm.deal.delete',{ id:dealId });
  console.log('удалено');
}
main().catch(e=>{console.error('❌',String(e).slice(0,300));process.exit(1);});
