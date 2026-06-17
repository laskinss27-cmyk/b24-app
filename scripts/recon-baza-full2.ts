import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function total(iblockId: number, extra: Record<string,unknown> = {}) {
  const r = await c.callBatch({ p: { method: 'catalog.product.list', params: { select: ['id','iblockId'], filter: { iblockId, ...extra } } } });
  return r.result_total['p'] ?? null;
}
async function main() {
  console.log('totals:');
  for (const ib of [24,26]) console.log(`  iblock ${ib}: ${await total(ib)}`);
  // есть ли parentId/property102/property360 в выдаче списка iblock 26 и 24?
  for (const ib of [26,24]) {
    const r = await c.call<{products?: Array<Record<string,unknown>>}>('catalog.product.list', { select: ['id','iblockId','name','parentId','property102','property360','type'], filter: { iblockId: ib }, order:{id:'ASC'} });
    const s = r?.products?.slice(0,4) ?? [];
    console.log(`\niblock ${ib} sample keys:`, s[0]?Object.keys(s[0]).join(', '):'(нет)');
    for (const p of s) console.log('  ', JSON.stringify({id:p['id'],name:String(p['name']??'').slice(0,28),type:p['type'],parentId:p['parentId'],property102:p['property102'],property360:p['property360']}));
  }
  // сколько у iblock 26 товаров типа 'товар с предложениями' (родители) vs простых?
  // type: 1=товар,3=товар с предложениями,4=предложение (примерно). Проверим распределение type на 26.
  console.log('\ntype distribution iblock 26 (по total с фильтром type):');
  for (const t of [1,3,4]) {
    const r = await c.callBatch({ p:{ method:'catalog.product.list', params:{ select:['id','iblockId'], filter:{ iblockId:26, type:t } } } });
    console.log(`  type=${t}: ${r.result_total['p'] ?? 0}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
