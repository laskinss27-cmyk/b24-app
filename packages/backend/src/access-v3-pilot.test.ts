import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyAccessV3Pilot } from '@b24-app/shared';
import { B24Client } from './b24/client.js';
import { appPermission } from './access-policy.js';
import { AccessV3Store } from './access-v3-store.js';
import { seedAccessV3 } from './access-v3-baseline.js';
import { previewAccessV3Pilot, registerAccessV3Pilot } from './access-v3-pilot.js';
import { ErpClient } from './erp/client.js';
import { registerCatalogErpStockRoute } from './routes/api-catalog-erp-stock-route.js';
import { baseCache } from './routes/api-catalog-cache.js';

const permission = 'catalog.view_purchase_prices';
const owner = { id: '1858', name: 'Owner', departments: [20] };
const directory = { fingerprint: 'test', stores: [], users: [owner], departments: [{ id: 20, name: 'Retail' }] };

test('activation requires explicit saved owner rule and refuses ambiguous department rules', () => {
	const current = seedAccessV3(directory);current.revision = 1;
	assert.throws(() => previewAccessV3Pilot({current,history:[]}, owner), /явное/);
	current.departments['20'] = {[permission]:'deny'};
	assert.equal(previewAccessV3Pilot({current,history:[]},owner).decision,'deny');
	current.departments['10'] = {[permission]:'allow'};
	assert.throws(() => previewAccessV3Pilot({current,history:[]},{...owner,departments:[10,20]}),/конфликт/);
	assert.throws(() => previewAccessV3Pilot({current,history:[]},{...owner,id:'1'}),/владельцу/);
});

test('published version is immutable, persisted, owner-only, CAS-protected and independently disabled', async t => {
	const root = await mkdtemp(join(tmpdir(),'b24-active-pilot-'));const store = new AccessV3Store(root);
	let actorId = '1858', brokenAuth = false, legacy = true;
	t.mock.method(B24Client.prototype,'call',async () => { if(brokenAuth)throw Error('offline');return {ID:actorId,UF_DEPARTMENT:[20]}; });
	const app=Fastify();app.decorate('config',{portalDomain:'pilot.example'} as typeof app.config);
	// Deliberately no old access hook: failure/missing cached identity must not bypass active restrictions.
	registerAccessV3Pilot(app,store);
	app.post('/api/catalog/browse',req=>({visible:appPermission(req,permission,legacy),priceEdit:appPermission(req,'catalog.edit_purchase_prices',true)}));
	app.post('/api/deal/plan',req=>({visible:appPermission(req,permission,true)}));
	const post=(action:string,data:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/access-control/v3/pilot/'+action,payload:{domain:'pilot.example',accessToken:'test-only',...data}});
	const read=(url='/api/catalog/browse')=>app.inject({method:'POST',url,payload:{domain:'pilot.example',accessToken:'test-only',userId:'1'}});
	try {
		assert.equal((await post('status')).json().state.active,false);assert.equal(await store.read('pilot.example'),null);
		const initial=seedAccessV3(directory);initial.employees['1858']={[permission]:'deny'};
		await store.save('pilot.example',0,initial,initial);
		assert.equal((await read()).json().visible,true);
		actorId='1';assert.equal((await post('status')).json().canActivate,false);assert.equal((await post('activate')).statusCode,403);assert.equal((await post('disable')).statusCode,403);
		actorId='101';assert.equal((await post('status',{userId:'1858'})).statusCode,403);actorId='1858';
		let preview=(await post('preview')).json();
		assert.equal((await post('activate',{draftRevision:1,pilotRevision:0,previewToken:'fake'})).statusCode,409);
		const activated=await post('activate',{draftRevision:preview.draftRevision,pilotRevision:preview.pilotRevision,previewToken:preview.token,userId:'101',permissionId:'realizations.post'});
		assert.equal(activated.json().state.userId,'1858');assert.equal(activated.json().state.permissionId,permission);
		assert.equal((await read()).json().visible,false);assert.equal((await read()).json().priceEdit,true);
		assert.equal((await read('/api/deal/plan')).json().visible,true);
		actorId='1';assert.equal((await read()).json().visible,true);actorId='1858';
		assert.equal((await app.inject({method:'POST',url:'/api/catalog/browse',payload:{domain:'pilot.example',userId:'1'}})).statusCode,403);
		brokenAuth=true;assert.equal((await read()).statusCode,503);brokenAuth=false;
		assert.equal((await new AccessV3Store(root).read('pilot.example'))?.pilot?.active,true);
		const saved=(await store.read('pilot.example'))!;const changed=structuredClone(saved.current);changed.employees['1858']![permission]='allow';
		await store.save('pilot.example',1,changed);assert.equal((await read()).json().visible,false);
		assert.equal((await post('activate',{draftRevision:preview.draftRevision,pilotRevision:preview.pilotRevision,previewToken:preview.token})).statusCode,409);
		preview=(await post('preview')).json();
		await post('activate',{draftRevision:preview.draftRevision,pilotRevision:preview.pilotRevision,previewToken:preview.token});
		assert.equal((await read()).json().visible,true);legacy=false;assert.equal((await read()).json().visible,false);legacy=true;
		const beforeDisable=(await store.read('pilot.example'))!.current;
		assert.equal((await post('disable',{pilotRevision:-1})).json().state.active,false);
		assert.equal((await read()).json().visible,true);assert.deepEqual((await store.read('pilot.example'))!.current,beforeDisable);
		assert.equal((await store.read('pilot.example'))!.pilotHistory!.length,3);
	} finally { await app.close(); }
});

test('active read errors fail closed and unrelated operations remain unaffected',async t=>{
	const store={read:async()=>{throw Error('corrupt');}} as unknown as AccessV3Store;
	const app=Fastify();app.decorate('config',{portalDomain:'pilot.example'} as typeof app.config);registerAccessV3Pilot(app,store);
	app.post('/api/catalog/browse',req=>({visible:appPermission(req,permission,true)}));app.post('/api/deal/plan',()=>({ok:true}));
	try{assert.equal((await app.inject({method:'POST',url:'/api/catalog/browse',payload:{}})).statusCode,503);assert.equal((await app.inject({method:'POST',url:'/api/deal/plan',payload:{}})).statusCode,200);}finally{await app.close();}
});

test('real ERP stocks route hides owner purchase prices while leaving another user and disabling unchanged',async t=>{
	let actorId='1858';t.mock.method(B24Client.prototype,'call',async()=>({ID:actorId,UF_DEPARTMENT:[20]}));
	t.mock.method(ErpClient,'fromEnv',()=>({list:async (doctype:string)=>{
		if(doctype==='Company')return [{name:'Test',abbr:'T'}];if(doctype==='Bin')return [{item_code:'16832',warehouse:'Main - T',actual_qty:2}];if(doctype==='Item Price')return [];throw Error('unexpected');
	}}));
	const current=seedAccessV3(directory);current.revision=1;
	const pilot={...emptyAccessV3Pilot(),active:true,decision:'deny' as const,draftRevision:1,revision:1};
	const store={read:async()=>({current,history:[],pilot})} as unknown as AccessV3Store;
	const app=Fastify();app.decorate('config',{portalDomain:'pilot.example'} as typeof app.config);registerAccessV3Pilot(app,store);registerCatalogErpStockRoute(app);
	baseCache.set('pilot.example',{expires:Date.now()+60000,data:{rows:[{id:16832,purchase:5200}] as never[],generatedAt:''}});
	const read=()=>app.inject({method:'POST',url:'/api/catalog/erp-stocks',payload:{domain:'pilot.example',accessToken:'test-only',productIds:[16832]}});
	try{assert.equal((await read()).json().byProduct[16832].purchasing,0);actorId='1';assert.equal((await read()).json().byProduct[16832].purchasing,5200);actorId='1858';pilot.active=false;assert.equal((await read()).json().byProduct[16832].purchasing,5200);}finally{await app.close();baseCache.delete('pilot.example');}
});
