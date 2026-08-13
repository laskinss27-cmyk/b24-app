import type { FastifyInstance } from 'fastify';
import type { AccessAuthBody } from '../access-policy.js';
import { diagnoseAdminDealDocuments } from '../admin/deal-document-diagnostics.js';
import {
	AdminDealFulfillmentSyncError,
	normalizeFulfillmentSyncComment,
	synchronizeAdminDealFulfillment,
} from '../admin/deal-fulfillment-synchronizer.js';
import { adminOwnerContext } from '../admin/owner-client.js';
import type { DealFulfillmentValue } from '../deal-fulfillment.js';
import { ErpClient } from '../erp/client.js';

interface SyncBody extends AccessAuthBody {
	dealId?: unknown;
	expectedCurrent?: unknown;
	expectedValue?: unknown;
	comment?: unknown;
}

function fulfillmentValue(value: unknown): DealFulfillmentValue | null {
	return value === 'ДА' || value === 'НЕТ' ? value : null;
}

async function recordFulfillmentSync(
	app: FastifyInstance,
	input: { dealId: number; previous: string; value: string; comment: string; actor?: { id: string; name: string }; error?: string },
): Promise<void> {
	const failed = Boolean(input.error);
	await app.operationLog.record({
		area: 'admin', operation: 'sync_deal_fulfillment', outcome: failed ? 'failure' : 'success', level: failed ? 'error' : 'warning',
		summary: failed
			? `Не удалось синхронизировать полную отгрузку сделки №${input.dealId}: ${input.error}`
			: `Полная отгрузка сделки №${input.dealId} изменена: «${input.previous}» → «${input.value}». Причина: ${input.comment}`,
		...(input.actor ? { actor: input.actor } : {}),
		dealId: input.dealId,
		details: {
			previous: input.previous, value: input.value, comment: input.comment.slice(0, 500),
			...(input.error ? { error: input.error.slice(0, 500) } : {}),
		},
	});
}

export function registerApiAdminDealFulfillmentRoute(app: FastifyInstance): void {
	app.post('/api/admin/deal-documents/sync-fulfillment', async (req, reply) => {
		const body = (req.body ?? {}) as SyncBody;
		const dealId = Number(body.dealId);
		const expectedCurrent = fulfillmentValue(body.expectedCurrent);
		const expectedValue = fulfillmentValue(body.expectedValue);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'Некорректный ID сделки.' });
		if (!expectedCurrent || !expectedValue || expectedCurrent === expectedValue) return reply.code(400).send({ ok: false, error: 'Некорректные значения технического поля.' });
		let comment: string;
		try { comment = normalizeFulfillmentSyncComment(body.comment); }
		catch (error) { return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
		let actor: { id: string; name: string } | undefined;
		try {
			const owner = await adminOwnerContext(app, body);
			if (!owner) return reply.code(403).send({ ok: false, error: 'Админка доступна только владельцу приложения.' });
			actor = owner.actor;
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: 'Ядро склада не настроено.' });
			const diagnostic = await diagnoseAdminDealDocuments(owner.client, erp, dealId);
			const result = await synchronizeAdminDealFulfillment(owner.client, erp, { dealId, expectedCurrent, expectedValue, comment }, diagnostic);
			await recordFulfillmentSync(app, { dealId, previous: result.previous, value: result.value, comment, ...(actor ? { actor } : {}) });
			return { ok: true, result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await recordFulfillmentSync(app, { dealId, previous: expectedCurrent, value: expectedValue, comment, ...(actor ? { actor } : {}), error: message });
			app.log.error({ dealId, error: message }, '[admin/deal-documents/sync-fulfillment] failed');
			if (error instanceof AdminDealFulfillmentSyncError) return reply.code(409).send({ ok: false, error: message });
			return reply.code(500).send({ ok: false, error: 'Не удалось синхронизировать техническое поле сделки. Подробности записаны в журнал операций.' });
		}
	});
}
