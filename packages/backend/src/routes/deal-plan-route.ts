import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { fetchServiceProductIds } from '../deal-product-catalog.js';
import { syncDealServiceSum } from '../deal-service-sum.js';
import { ErpClient } from '../erp/client.js';
import { listDealPlan } from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealPlanRoute(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// СОСТАВ СДЕЛКИ ИЗ ЯДРА (план = строки черновика Sales Order). Источник правды для нашей вкладки:
	// показываем реальные товары, что бы Б24 ни подменял в своей карточке. Без ядра возвращаем явную ошибку.
	app.post('/api/deal/plan', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const items = await listDealPlan(erp, dealId);
			const serviceIds = await fetchServiceProductIds(client, items.map((item) => item.productId));
			for (const item of items) item.isService = item.isService || serviceIds.has(item.productId);
			// Поле могло остаться пустым, если состав был создан до появления синхронизации
			// или менялся не через наше окно. Открытие вкладки — безопасная точка сверки:
			// syncDealServiceSum не пишет сделку повторно, когда сумма уже актуальна.
			try {
				const serviceSum = await syncDealServiceSum(client, erp, dealId);
				app.log.info({ dealId, ...serviceSum }, '[deal-service-sum] synchronized on plan load');
			} catch (error) {
				app.log.error({ dealId }, `[deal-service-sum] plan-load synchronization failed — ${errInfo(error)}`);
			}
			return { ok: true, items };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/plan] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
