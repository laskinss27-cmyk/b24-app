import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
(async()=>{
  console.log('=== Б24 productrows сделки 36992 (что ЧИТАЕТ вкладка) ===');
  const rows = await client.call<Array<Record<string,unknown>>>('crm.deal.productrows.get',{id:36992}) ?? [];
  for(const r of rows) console.log(`  TYPE=${r['TYPE']} PRODUCT_ID=${r['PRODUCT_ID']} "${r['PRODUCT_NAME']}" qty=${r['QUANTITY']} price=${r['PRICE']}`);
})().catch(e=>console.error(e));
