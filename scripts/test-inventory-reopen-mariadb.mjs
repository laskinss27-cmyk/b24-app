// Run ONLY in the disposable container/network described in the release procedure.
import assert from 'node:assert/strict';
import {copyFile, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {applyMigrations} from '../packages/backend/dist/database/migrations.js';
import {createNativeInventorySql, updateNativeInventorySql} from '../packages/backend/dist/inventory-sql/writer.js';
import {readInventorySqlRecords} from '../packages/backend/dist/inventory-sql/reader.js';
import {inventorySqlRecordToBitrixItem} from '../packages/backend/dist/inventory-sql/read-shadow.js';
import {loadInventoryItems, updateInventoryData} from '../packages/backend/dist/routes/inventory-storage.js';
assert.equal(process.env.B24_INVENTORY_REOPEN_ISOLATED_TEST, '1', 'Explicit disposable-test opt-in required');
assert.equal(process.env.B24_APP_DB_HOST, undefined, 'Production DB configuration must not be present');
const require=createRequire(new URL('../packages/backend/package.json',import.meta.url));
const mariadb=require('mariadb');
const options={host:'b24-inventory-reopen-test-db',port:3306,user:'root',password:'isolated-rehearsal-only',connectionLimit:2};
const root=mariadb.createPool(options);
const database='inventory_reopen_isolated';
let pool;
try {
 for(let attempt=0;;attempt++){
  try{await root.query('SELECT 1');break;}catch(error){if(attempt>=40)throw error;await new Promise(resolve=>setTimeout(resolve,500));}
 }
 await root.query(`CREATE DATABASE ${database}`); // Fail rather than replace any existing database.
 pool=mariadb.createPool({...options,database});
 const dir=await mkdtemp(join(tmpdir(),'inventory-reopen-schema-'));
 const migrations=fileURLToPath(new URL('../packages/backend/migrations/',import.meta.url));
 for(const file of [
  '0057_create_inventory_records.sql','0058_create_inventory_sections.sql','0059_create_inventory_points.sql',
  '0060_create_inventory_snapshot_lines.sql','0061_create_inventory_count_lines.sql','0062_create_inventory_result_lines.sql',
  '0063_create_inventory_erp_documents.sql','0064_create_inventory_backfill_checkpoints.sql','0065_allow_inventory_root_section.sql',
  '0066_add_inventory_result_book_at.sql','0067_allow_legacy_inventory_result_counts.sql','0068_add_inventory_public_id.sql',
  '0069_create_inventory_public_ids.sql','0070_create_inventory_identity_checkpoints.sql','0071_make_inventory_bitrix_identity_optional.sql',
  '0072_create_inventory_mutations.sql','0073_create_inventory_commands.sql','0074_create_inventory_bitrix_outbox.sql',
  '0113_add_inventory_result_retail_price.sql',
 ])await copyFile(join(migrations,file),join(dir,file));
 assert.equal((await applyMigrations(pool,dir)).length,19);
 const data={status:'active',createdById:'1',createdAt:'2026-09-14T08:00:00.000Z',sectionIds:[0],points:[{
  storeId:-100,storeName:'TEST ONLY',status:'in_progress',responsibleId:'2',responsibleName:'Test',
  stockSnapshot:{version:1,capturedAt:'2026-09-14T08:00:00.000Z',lines:[[10,3]]},
  draft:{10:2},comments:{10:'Test count'},draftSessionId:'session',draftSequence:1,
  result:{total:1,counted:1,discrepancies:1,lines:[{productId:10,name:'TEST',book:3,fact:2,diff:-1,retailPrice:10}]},
 }]};
 const created=await createNativeInventorySql(pool,{idempotencyKey:'isolated-create',name:'TEST ONLY',data,createdById:'1',createdAt:data.createdAt});
 const app={config:{inventorySqlRead:'primary'},inventorySqlWriter:{mode:'primary',enabled:true,
  updateNative:input=>updateNativeInventorySql(pool,input),async claimMirror(){return false;},async pendingMirrors(){return [];}},
  databaseRuntime:{mode:'readiness',readInventoryRecords:()=>readInventorySqlRecords(pool)},log:{info(){},warn(){}}};
 const client={async call(){assert.fail('No Bitrix or ERP calls allowed');}};
 async function load(){return (await loadInventoryItems(app,client,'list')).find(item=>Number(item.ID)===created.publicId);}
 async function save(target){const source=await load();await updateInventoryData(app,client,{id:created.publicId,name:source.NAME,data:target,sourceItem:source});}
 const draft=JSON.parse((await load()).DETAIL_TEXT);
 await save(draft); // Seed the historical content-hash command that triggers the defect.
 const submitted=structuredClone(draft);submitted.points[0].status='submitted';submitted.points[0].submittedAt='2026-09-14T09:00:00.000Z';
 for(let cycle=0;cycle<3;cycle++){
  await save(submitted);
  assert.equal(JSON.parse((await load()).DETAIL_TEXT).points[0].status,'submitted');
  const reopened=JSON.parse((await load()).DETAIL_TEXT);
  reopened.points[0].status='in_progress';delete reopened.points[0].submittedAt;delete reopened.points[0].actAt;
  await save(reopened);
  assert.deepEqual(JSON.parse((await load()).DETAIL_TEXT),draft,'reopen must survive a fresh SQL read');
  const before=(await pool.query('SELECT COUNT(*) n FROM inventory_mutations'))[0].n;
  await save(reopened);
  assert.equal((await pool.query('SELECT COUNT(*) n FROM inventory_mutations'))[0].n,before,'current state retry must not create another mutation');
 }
 // A new connection, independent of any UI or runtime object, sees persisted values.
 const fresh=await mariadb.createConnection({...options,database});
 try{
  const records=await readInventorySqlRecords({query:(...args)=>fresh.query(...args)});
  assert.deepEqual(JSON.parse(inventorySqlRecordToBitrixItem(records[0]).DETAIL_TEXT),draft);
  assert.equal((await fresh.query('SELECT COUNT(*) n FROM inventory_erp_documents'))[0].n,0n);
 }finally{await fresh.end();}
 console.log('isolated_mariadb_reopen=PASS cycles=3 fresh_connection=PASS counts_and_snapshot=UNCHANGED erp_documents=0');
}finally{if(pool)await pool.end();await root.end();}
