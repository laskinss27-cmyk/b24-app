import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('no DEV_WEBHOOK'); process.exit(1); }
const c = new B24Client({ auth: { kind: 'webhook', url: webhook } });
async function main() {
  for (const params of [{}, { scope: 'catalog' }, { scope: 'sale' }, { scope: 'crm' }] as Record<string,unknown>[]) {
    try {
      const r = await c.call<unknown>('placement.list', params);
      console.log(`\n=== placement.list ${JSON.stringify(params)} ===`);
      console.log(JSON.stringify(r, null, 1).slice(0, 3000));
    } catch (e) {
      console.log(`\n=== placement.list ${JSON.stringify(params)} → ${e instanceof B24ApiError ? e.code+': '+e.description : String(e)}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
