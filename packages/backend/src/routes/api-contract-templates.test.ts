import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { CONTRACT_TEMPLATES, type ContractGenerateInput } from '../deal-contract.js';
import { registerApiContractsRoute } from './api-contracts.js';

test('generation accepts every available catalog template including Shelly; unknown IDs and invalid supply terms fail before generation', async t => {
	const app = Fastify();
	app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	const calls: ContractGenerateInput[] = [];
	registerApiContractsRoute(app, async (_client, dealId, input) => {
		assert.equal(dealId, 37970); calls.push(input);
		return { file: Buffer.from('test'), filename: 'test.docx', contractNumber: 'TEST', document: { id: 'test' } as never };
	});
	t.after(() => app.close());
	const payload = { domain: 'test.example', accessToken: 'test', dealId: 37970, companyId: 1, customerKind: 'company', contractDate: '2026-09-09', workDuration: 14, workDurationUnit: 'working', supplyPrepaymentPercent: 90, supplyDeliveryDays: 180 };
	for (const template of CONTRACT_TEMPLATES.filter(t => t.available)) {
		const response = await app.inject({ method: 'POST', url: '/api/contracts/generate', payload: { ...payload, templateId: template.id } });
		assert.equal(response.statusCode, 200, template.id); assert.equal(response.json().ok, true);
		assert.equal(calls.at(-1)?.templateId, template.id);
		if (template.usesSupplyTerms) { assert.equal(calls.at(-1)?.supplyPrepaymentPercent, 90); assert.equal(calls.at(-1)?.supplyDeliveryDays, 180); }
	}
	const count = calls.length;
	for (const templateId of ['', 'missing', '../supply_shelly', 'SUPPLY_SHELLY']) {
		const response = await app.inject({ method: 'POST', url: '/api/contracts/generate', payload: { ...payload, templateId } });
		assert.equal(response.statusCode, 400); assert.match(response.json().error, /шаблон договора не найден/); assert.doesNotMatch(response.json().error, /bad templateId/);
	}
	for (const templateId of ['supply_shelly', 'supply']) {
		for (const override of [{ customerKind: 'person' }, { supplyPrepaymentPercent: 101 }, { supplyDeliveryDays: 0 }]) {
			const response = await app.inject({ method: 'POST', url: '/api/contracts/generate', payload: { ...payload, templateId, ...override } });
			assert.equal(response.statusCode, 400);
		}
	}
	const wrongPortal = await app.inject({ method: 'POST', url: '/api/contracts/generate', payload: { ...payload, domain: 'other.example', templateId: 'supply_shelly' } });
	assert.equal(wrongPortal.statusCode, 403); assert.equal(calls.length, count);
});
