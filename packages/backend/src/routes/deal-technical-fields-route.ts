import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { backfillDealFulfillmentSince, ensureDealFulfillmentField, syncDealFulfillmentStatus } from '../deal-fulfillment.js';
import { backfillDealServiceSumSince, ensureDealServiceSumField, syncDealServiceSum } from '../deal-service-sum.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealTechnicalFieldsRoute(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Однократная административная настройка: создать служебное поле и заполнить новые сделки.
	app.post('/api/deal/fulfillment-setup', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { from?: unknown; dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const from = String(b.from ?? '2026-07-20').trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return reply.code(400).send({ ok: false, error: 'bad from' });
		const dealId = Number(b.dealId);
		if (b.dealId !== undefined && (!Number.isInteger(dealId) || dealId <= 0)) {
			return reply.code(400).send({ ok: false, error: 'bad dealId' });
		}
		try {
			const me = await client.call<{ ID?: unknown }>('user.current', {});
			if (!['1', '1858'].includes(String(me?.['ID'] ?? ''))) return reply.code(403).send({ ok: false, error: 'настройка доступна администратору' });
			const field = await ensureDealFulfillmentField(client);
			const serviceSumField = await ensureDealServiceSumField(client);
			const currentDeal = Number.isInteger(dealId) && dealId > 0
				? {
					fulfillment: await syncDealFulfillmentStatus(client, erp, dealId),
					serviceSum: await syncDealServiceSum(client, erp, dealId),
				}
				: null;
			void backfillDealFulfillmentSince(client, erp, from)
				.then((result) => app.log.info({ from, ...result }, '[deal-fulfillment] background backfill completed'))
				.catch((err) => app.log.error({ from }, `[deal-fulfillment] background backfill failed — ${errInfo(err)}`));
			void backfillDealServiceSumSince(client, erp, from)
				.then((result) => app.log.info({ from, ...result }, '[deal-service-sum] background backfill completed'))
				.catch((err) => app.log.error({ from }, `[deal-service-sum] background backfill failed — ${errInfo(err)}`));
			app.log.info({ from, dealId: currentDeal ? dealId : undefined, field, serviceSumField, currentDeal }, '[deal-technical-fields] setup scheduled');
			return { ok: true, field, serviceSumField, currentDeal, backfillScheduled: true, checked: 0, changed: 0, failed: 0 };
		} catch (err) {
			app.log.error({}, `[deal-fulfillment] setup failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
