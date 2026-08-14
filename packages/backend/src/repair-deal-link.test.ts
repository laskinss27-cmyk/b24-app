import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from './b24/client.js';
import { addRepairLinkToDealTimeline, buildRepairDeepLink } from './repair-deal-link.js';

test('repair deep link opens one exact repair inside the marketplace app', () => {
	const comment = buildRepairDeepLink({
		portalDomain: 'portal.example.bitrix24.ru',
		appClientId: 'local.abc',
		repairId: 20822,
		repairNo: 130,
	});

	assert.equal(
		comment,
		'[URL=https://portal.example.bitrix24.ru/marketplace/view/local.abc/?params%5BrepairId%5D=20822]Открыть ремонт #130[/URL]',
	);
});

test('repair link is added as a deal timeline comment without updating deal fields', async () => {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const client = {
		call: async (method: string, params: Record<string, unknown>) => {
			calls.push({ method, params });
			return 1;
		},
	} as unknown as B24Client;

	await addRepairLinkToDealTimeline(client, 37890, '[URL=https://example.test/repair/20822]Открыть ремонт #130[/URL]');

	assert.deepEqual(calls, [{
		method: 'crm.timeline.comment.add',
		params: {
			fields: {
				ENTITY_ID: 37890,
				ENTITY_TYPE: 'deal',
				COMMENT: '[URL=https://example.test/repair/20822]Открыть ремонт #130[/URL]',
			},
		},
	}]);
	assert.equal(calls.some((call) => call.method === 'crm.deal.update'), false);
});
