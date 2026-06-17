import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m:string,p:Record<string,unknown>={}):Promise<T|null>{try{return await c.call<T>(m,p);}catch(e){console.log(`  ⛔ ${m} → ${String(e).slice(0,120)}`);return null;}}
async function main(){
  console.log('=== crm.deal.fields → SOURCE_ID и прочие enum/UF ===');
  const df = await call<Record<string,any>>('crm.deal.fields');
  for(const [k,v] of Object.entries(df??{})) {
    const title = v?.title ?? '';
    if(/source|источник|склад|store|точк/i.test(k+' '+title)) console.log(`   ${k}: type=${v?.type} title="${title}"`);
  }
  console.log('\n=== значения «Источник» (crm.status ENTITY_ID=SOURCE) ===');
  const src = await call<Array<Record<string,unknown>>>('crm.status.list',{ filter:{ ENTITY_ID:'SOURCE' }, select:['STATUS_ID','NAME','SORT'], order:{SORT:'ASC'} });
  for(const s of src??[]) console.log(`   STATUS_ID=${s['STATUS_ID']}  NAME="${s['NAME']}"`);
  console.log('\n=== на всякий: список UF сделки (вдруг кастомное поле склада) ===');
  const uf = await call<Array<Record<string,unknown>>>('crm.deal.userfield.list',{});
  for(const f of uf??[]) console.log(`   ${f['FIELD_NAME']} "${f['EDIT_FORM_LABEL']?Object.values(f['EDIT_FORM_LABEL'] as any)[0]:''}" type=${f['USER_TYPE_ID']}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
