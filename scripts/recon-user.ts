import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function main(){
  const u = await c.call<Array<Record<string,unknown>>>('user.get',{ FILTER:{ LAST_NAME:'Дранишников' } });
  for(const x of u??[]) console.log(`ID=${x['ID']}  ${x['LAST_NAME']} ${x['NAME']}  active=${x['ACTIVE']}`);
}
main().catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
