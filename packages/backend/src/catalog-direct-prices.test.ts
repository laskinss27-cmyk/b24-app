import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { B24Client } from './b24/client.js';
import { resolveCurrentAccess, ACCESS_POLICY_ENFORCEMENT_ENABLED, ACCESS_POLICY_EDITOR_ENABLED } from './access-policy.js';
import { registerAccessPolicyHook } from './access-policy-hook.js';
import { registerCatalogCommercialFieldRoutes } from './routes/api-catalog-commercial-field-routes.js';
import { seedAccessV3 } from './access-v3-baseline.js';

test('Vladimir receives exactly two price overrides; actor identity cannot be supplied by caller', async t => {
	let id = '1';
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		if (method === 'user.current') return { ID: id, NAME: 'Владимир', LAST_NAME: 'Дранишников', UF_DEPARTMENT: [254,48] };
		if (method === 'app.option.get') return {};
		throw new Error('Unexpected Bitrix call: ' + method);
	});
	const app = Fastify();app.decorate('config', { portalDomain: 'prices.example' } as typeof app.config);
	registerAccessPolicyHook(app);registerCatalogCommercialFieldRoutes(app);
	try {
		for (const actor of ['1','101','986','1858']) {
			id = actor;const auth = { domain: 'prices.example', accessToken: 'test-price-' + actor };
			const access = await resolveCurrentAccess(app, auth, true);assert.ok(access);
			assert.deepEqual(Object.entries(access.decisions).filter(([,v])=>v==='allow').map(([k])=>k).sort(), actor === '1' ? ['catalog.edit_purchase_prices','catalog.edit_retail_prices'] : []);
			// Invalid ID reaches validation only if both price permissions pass; never reaches a business write.
			const response = await app.inject({ method:'POST', url:'/api/catalog/update-prices', payload:{...auth,userId:'1',productId:0,retail:100,purchase:50} });
			assert.equal(response.statusCode, actor === '1' ? 400 : 403);
		}
		assert.equal(ACCESS_POLICY_ENFORCEMENT_ENABLED,false);assert.equal(ACCESS_POLICY_EDITOR_ENABLED,false);
		const draft=seedAccessV3({fingerprint:'test',stores:[],departments:[{id:254,name:'Отдел'}],users:[{id:'1',name:'Владимир',departments:[254]}]});
		assert.equal(draft.employees['1']?.['catalog.edit_purchase_prices'],'allow');assert.equal(draft.employees['1']?.['catalog.edit_retail_prices'],'allow');
	} finally { await app.close(); }
});
