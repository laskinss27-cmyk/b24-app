import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l:string,d:unknown){let s=JSON.stringify(d,null,1);if(s&&s.length>2500)s=s.slice(0,2500)+'…';console.log(l+': '+s);}
async function tc<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await client.call<T>(m,p)}catch(e){console.log('  ⛔ '+m+' → '+(e instanceof B24ApiError?e.code+':'+(e.description??''):String(e)));return null}}
(async()=>{
  console.log('=== granted scopes ===');
  j('scope', await tc('scope'));
  console.log('\n=== все доступные методы (фильтр по ключевым словам) ===');
  const methods = await tc<string[]>('methods',{});
  const arr = Array.isArray(methods)?methods:[];
  console.log('всего методов:', arr.length);
  const hit = arr.filter(m=>/order|shipment|sale|binding|realiz|deal.*order|timeline|delivery|payment|document/i.test(m));
  console.log('релевантные:\n'+hit.map(m=>'  '+m).join('\n'));
})().catch(e=>{console.error('FATAL',e)});
