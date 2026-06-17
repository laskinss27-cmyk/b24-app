import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tryc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await c.call<T>(m,p);}catch(e){console.log(`  ⛔ ${m} → ${String(e).slice(0,160)}`);return null;}}
async function main(){
  // 1. документы прихода/оприходования (docType A=приход, S=оприходование), проведённые
  console.log('=== документы (последние) ===');
  const docs = await tryc<{documents?:Array<Record<string,unknown>>}>('catalog.document.list',{ select:['id','docType','status','title','dateCreate'], order:{id:'DESC'} });
  const list = (docs?.documents??[]).slice(0,15);
  for(const d of list) console.log(`  #${d['id']} type=${d['docType']} status=${d['status']} ${String(d['title']??'').slice(0,40)}`);
  // берём проведённый (status Y) документ прихода/оприходования
  const conducted = (docs?.documents??[]).find(d=>String(d['status'])==='Y' && ['A','S'].includes(String(d['docType'])));
  if(!conducted){console.log('нет проведённого A/S документа в первых страницах'); }
  const docId = Number(conducted?.['id']??0);
  console.log(`\n=== элементы документа #${docId} (type=${conducted?.['docType']}) ===`);
  if(docId){
    const els = await tryc<{documentElements?:Array<Record<string,unknown>>}>('catalog.document.element.list',{ filter:{docId}, select:['id','elementId','amount','purchasingPrice','basePrice','storeTo'] });
    const elements = (els?.documentElements??[]).slice(0,8);
    for(const e of elements){
      const pid = Number(e['elementId']);
      const prod = await tryc<{products?:Array<Record<string,unknown>>}>('catalog.product.list',{ select:['id','iblockId','purchasingPrice'], filter:{ id:pid } });
      const pp = prod?.products?.[0]?.['purchasingPrice'];
      console.log(`  товар #${pid}: в документе purchasingPrice=${e['purchasingPrice']} basePrice=${e['basePrice']} amount=${e['amount']} | у ТОВАРА сейчас purchasingPrice=${pp}`);
    }
  }
  console.log('\nГОТОВО');
}
main().catch(e=>{console.error(e);process.exit(1);});
