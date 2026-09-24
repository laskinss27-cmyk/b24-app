import {loadDatabaseConfig} from '/app/packages/backend/dist/database/config.js';
import {createDatabaseRuntime} from '/app/packages/backend/dist/database/runtime.js';
import {buildSqlProductBase} from '/app/packages/backend/dist/catalog-mirror/product-base.js';
import {applyLiveCatalogStock,readLiveCatalogStock} from '/app/packages/backend/dist/catalog-mirror/live-stock.js';
import {ErpClient} from '/app/packages/backend/dist/erp/client.js';
const runtime=createDatabaseRuntime(loadDatabaseConfig());
try{
 const plan=await runtime.readLatestCatalogMirrorPlan();
 if(!plan)throw Error('No complete catalog checkpoint');
 const erp=ErpClient.fromEnv();if(!erp)throw Error('ERP unavailable');
 const base=applyLiveCatalogStock(buildSqlProductBase(plan),await readLiveCatalogStock(erp));
 const items=base.data.rows.map(r=>({id:String(r.id),name:r.name,description:r.description,content:r.content}));
 process.stdout.write(JSON.stringify({generatedAt:new Date().toISOString(),summary:{observedAt:plan.observedAt,snapshotHash:plan.snapshotHash,positiveStockItems:base.data.rows.filter(r=>r.total>0).length,totalCatalogItems:items.length},items}));
}finally{await runtime.close();}
