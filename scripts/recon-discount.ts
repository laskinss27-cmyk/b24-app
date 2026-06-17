import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={}):Promise<T>{return c.call<T>(m,p);}
async function probe(label:string, row:Record<string,unknown>){
  const id = await call<number>('crm.deal.add',{ fields:{ TITLE:'ТЕСТ disc', CATEGORY_ID:6, STAGE_ID:'C6:NEW' } });
  await call('crm.deal.productrows.set',{ id, rows:[ row ] });
  const rows = await call<Array<Record<string,unknown>>>('crm.deal.productrows.get',{ id });
  const r = rows[0]||{};
  console.log(`${label}: PRICE=${r.PRICE} NETTO=${r.PRICE_NETTO} EXCL=${r.PRICE_EXCLUSIVE} DISC_SUM=${r.DISCOUNT_SUM} (итог строки = PRICE*QTY)`);
  await call('crm.deal.delete',{ id });
}
async function main(){
  console.log('цель: розница 35000, скидка 10% → итоговая цена 31500');
  await probe('A PRICE=35000 +10%       ', { PRODUCT_ID:1924, PRICE:35000, QUANTITY:1, DISCOUNT_TYPE_ID:2, DISCOUNT_RATE:10 });
  await probe('B PRICE_NETTO=35000 +10% ', { PRODUCT_ID:1924, PRICE_NETTO:35000, QUANTITY:1, DISCOUNT_TYPE_ID:2, DISCOUNT_RATE:10 });
  await probe('C PRICE=35000 DISC_SUM=3500', { PRODUCT_ID:1924, PRICE:35000, QUANTITY:1, DISCOUNT_TYPE_ID:1, DISCOUNT_SUM:3500 });
  await probe('D PRICE_EXCL=35000 +10%  ', { PRODUCT_ID:1924, PRICE_EXCLUSIVE:35000, QUANTITY:1, DISCOUNT_TYPE_ID:2, DISCOUNT_RATE:10 });
}
main().catch(e=>{console.error('❌',String(e).slice(0,200));process.exit(1);});
