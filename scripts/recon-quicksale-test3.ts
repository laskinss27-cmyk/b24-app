import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={}):Promise<T>{return c.call<T>(m,p);}
const round2=(n:number)=>Math.round(n*100)/100;
async function main(){
  const pct=10, retail=35000;
  const id = await call<number>('crm.deal.add',{ fields:{ TITLE:'ТЕСТ qs source+contact+disc', CATEGORY_ID:6, STAGE_ID:'C6:NEW', CONTACT_ID:698, SOURCE_ID:'STORE' } });
  console.log('сделка', id);
  await call('crm.deal.productrows.set',{ id, rows:[
    { PRODUCT_ID:1924, PRODUCT_NAME:'Жёсткий диск', PRICE:round2(retail*(1-pct/100)), QUANTITY:2, DISCOUNT_TYPE_ID:2, DISCOUNT_RATE:pct },
  ]});
  const d = await call<Record<string,unknown>>('crm.deal.get',{ id });
  console.log('CATEGORY_ID=',d['CATEGORY_ID'],'STAGE_ID=',d['STAGE_ID'],'SOURCE_ID=',d['SOURCE_ID'],'CONTACT_ID=',d['CONTACT_ID'],'OPPORTUNITY=',d['OPPORTUNITY']);
  const rows = await call<Array<Record<string,unknown>>>('crm.deal.productrows.get',{ id });
  for(const r of rows) console.log(`  строка: PRICE=${r['PRICE']} (итог) NETTO=${r['PRICE_NETTO']} DISC_RATE=${r['DISCOUNT_RATE']} DISC_SUM=${r['DISCOUNT_SUM']} QTY=${r['QUANTITY']}`);
  console.log('ожидание: NETTO≈35000, PRICE=31500, итог строки 31500×2=63000');
  await call('crm.deal.delete',{ id });
  console.log('удалено ✅');
}
main().catch(e=>{console.error('❌',String(e).slice(0,250));process.exit(1);});
