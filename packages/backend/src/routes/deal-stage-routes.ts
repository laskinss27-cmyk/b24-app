import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { setDealB24Service } from '../deal-product-catalog.js';
import { ErpClient } from '../erp/client.js';
import {
	assertDealQuoteVariantSelected,
	calculateDealPlanTotal,
	listDealStages,
	removeDealStageItem,
	renameDealStage,
	syncDealRealizationPrices,
	updateDealStageItem,
} from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;
type SyncDealTechnicalFields = (client: B24Client, erp: ErpClient, dealId: number) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealStageRoutes(
	app: FastifyInstance,
	clientFrom: DealClientFrom,
	syncDealTechnicalFields: SyncDealTechnicalFields,
): void {
	app.post('/api/deal/stages', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			return { ok: true, stages: await listDealStages(erp, dealId) };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/stages] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/deal/stage-rename', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; stageId?: unknown; name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		const stageId = String(b.stageId ?? '').trim();
		if (!Number.isInteger(dealId) || dealId <= 0 || !stageId) return reply.code(400).send({ ok: false, error: 'некорректный этап' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			await assertDealQuoteVariantSelected(erp, dealId);
			return { ok: true, stages: await renameDealStage(erp, dealId, stageId, String(b.name ?? '')) };
		} catch (err) {
			app.log.error({ dealId, stageId }, `[api/deal/stage-rename] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/deal/stage-item-update', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; stageId?: unknown; productId?: unknown; quantity?: unknown; price?: unknown; discountPercent?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		const stageId = String(b.stageId ?? '').trim();
		const productId = Number(b.productId);
		const quantity = Number(b.quantity);
		const price = Number(b.price);
		const discountPercent = Number(b.discountPercent);
		if (!Number.isInteger(dealId) || dealId <= 0 || !stageId || !Number.isInteger(productId) || productId <= 0
			|| !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0
			|| !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
			return reply.code(400).send({ ok: false, error: 'некорректные данные строки этапа' });
		}
		try {
			await assertDealQuoteVariantSelected(erp, dealId);
			const previousStage = (await listDealStages(erp, dealId)).find((stage) => stage.id === stageId);
			const previous = previousStage?.items.find((line) => line.productId === productId);
			if (!previous) throw new Error('позиция этапа не найдена');
			const previousFinalPrice = Math.round(previous.price * (1 - (previous.discountPercent ?? 0) / 100) * 100) / 100;
			const nextFinalPrice = Math.round(price * (1 - discountPercent / 100) * 100) / 100;
			const priceChanged = Math.abs(nextFinalPrice - previousFinalPrice) >= 0.005;
			if (priceChanged) {
				await syncDealRealizationPrices(erp, dealId, [{ productId, segmentId: `stage:${stageId}`, rate: nextFinalPrice }]);
			}
			try {
				await updateDealStageItem(erp, dealId, stageId, productId, quantity, price, discountPercent);
			} catch (error) {
				if (priceChanged) {
					await syncDealRealizationPrices(erp, dealId, [{ productId, segmentId: `stage:${stageId}`, rate: previousFinalPrice }]);
				}
				throw error;
			}
			const total = await calculateDealPlanTotal(erp, dealId);
			await setDealB24Service(client, dealId, total);
			await syncDealTechnicalFields(client, erp, dealId);
			return { ok: true, total };
		} catch (err) {
			app.log.error({ dealId, stageId, productId }, `[api/deal/stage-item-update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/deal/stage-item-remove', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; stageId?: unknown; productId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		const stageId = String(b.stageId ?? '').trim();
		const productId = Number(b.productId);
		if (!Number.isInteger(dealId) || dealId <= 0 || !stageId || !Number.isInteger(productId) || productId <= 0) {
			return reply.code(400).send({ ok: false, error: 'некорректные данные строки этапа' });
		}
		try {
			await assertDealQuoteVariantSelected(erp, dealId);
			await removeDealStageItem(erp, dealId, stageId, productId);
			const total = await calculateDealPlanTotal(erp, dealId);
			await setDealB24Service(client, dealId, total);
			await syncDealTechnicalFields(client, erp, dealId);
			return { ok: true, total };
		} catch (err) {
			app.log.error({ dealId, stageId, productId }, `[api/deal/stage-item-remove] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
