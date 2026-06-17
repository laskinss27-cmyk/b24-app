import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tryc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await c.call<T>(m,p);}catch(e){console.log(`  ⛔ ${m} → ${String(e).slice(0,140)}`);return null;}}
async function main(){
  // проведённые приходы (A) — берём 3 последних
  const docs = await tryc<{documents?:Array<Record<string,unknown>>}>('catalog.document.list',{ select:['id','docType','status'], filter:{docType:'A',status:'Y'}, order:{id:'DESC'} });
  const ids = (docs?.documents??[]).slice(0,3).map(d=>Number(d['id']));
  console.log('проведённые приходы:', JSON.stringify(ids));
  for(const docId of ids){
    const els = await tryc<{documentElements?:Array<Record<string,unknown>>}>('catalog.document.element.list',{ filter:{docId}, select:['elementId','amount','purchasingPrice'] });
    const elements = (els?.documentElements??[]).slice(0,4);
    console.log(`\n=== приход #${docId} ===`);
    for(const e of elements){
      const pid = Number(e['elementId']);
      const prod = await tryc<{product?:Record<string,unknown>}>('catalog.product.get',{ id:pid });
      const pp = prod?.product?.['purchasingPrice'];
      const ib = prod?.product?.['iblockId'];
      console.log(`  товар #${pid} (ib${ib}): в документе=${e['purchasingPrice']} | у товара purchasingPrice=${pp}  → ${String(pp)===String(e['purchasingPrice'])?'СОВПАДАЕТ':'отличается'}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
