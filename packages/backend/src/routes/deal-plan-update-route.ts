import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { fetchServiceProductIds, setDealB24Service } from '../deal-product-catalog.js';
import { ErpClient } from '../erp/client.js';
import {
	assertDealQuoteVariantSelected,
	calculateDealPlanTotal,
	listDealPlan,
	syncDealRealizationPrices,
	syncSupplyRequestQuantitiesFromDeal,
	updateDealQuoteVariantItems,
	upsertDealPlan,
	type DealQuoteVariantItem,
} from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;
type SupplyTransferAllocation = (client: B24Client, dealId: number) => Promise<Map<string, Map<number, number>>>;
type SyncDealTechnicalFields = (client: B24Client, erp: ErpClient, dealId: number) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealPlanUpdateRoute(
	app: FastifyInstance,
	clientFrom: DealClientFrom,
	supplyTransferAllocation: SupplyTransferAllocation,
	syncDealTechnicalFields: SyncDealTechnicalFields,
): void {
	// ПЕРЕЗАПИСАТЬ состав плана сделки целиком (из вкладки: правка кол-ва/цены, удаление строк) →
	// затем пересчитать служебную строку с общей суммой в Б24. items=[] → план пуст и Б24-строки очищаются.
	app.post('/api/deal/plan-set', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown; variantId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const lines = (Array.isArray(b.items) ? b.items : [])
			.map((it) => it as { productId?: unknown; itemName?: unknown; qty?: unknown; priceListRate?: unknown; discountPercent?: unknown; isService?: unknown; lineKey?: unknown })
			.map((it) => ({ productId: Number(it.productId), itemName: String(it.itemName ?? ''), qty: Number(it.qty), priceListRate: Number(it.priceListRate), discountPercent: Number(it.discountPercent) || 0, isService: Boolean(it.isService), lineKey: String(it.lineKey ?? '').trim() }))
			.filter((it) => Number.isInteger(it.productId) && it.productId > 0 && Number.isFinite(it.qty) && it.qty > 0 && Number.isFinite(it.priceListRate) && it.priceListRate >= 0 && it.discountPercent >= 0 && it.discountPercent <= 100);
		try {
			const serviceIds = await fetchServiceProductIds(client, lines.map((l) => l.productId));
			for (const line of lines) line.isService = line.isService || serviceIds.has(line.productId);
			const variantId = String(b.variantId ?? '').trim();
			if (variantId) {
				const variantItems: DealQuoteVariantItem[] = lines.map((line) => ({ productId: line.productId, itemName: line.itemName || `#${line.productId}`, qty: line.qty, priceListRate: line.priceListRate, discountPercent: line.discountPercent, isService: line.isService }));
				await updateDealQuoteVariantItems(erp, dealId, variantId, variantItems);
				const total = Math.round(variantItems.reduce((sum, item) => sum + item.priceListRate * (1 - item.discountPercent / 100) * item.qty, 0) * 100) / 100;
				return { ok: true, total, lines: variantItems.length };
			}
			const previousPlan = await listDealPlan(erp, dealId);
			await assertDealQuoteVariantSelected(erp, dealId);
			const today = new Date().toISOString().slice(0, 10);
			const previousByProduct = new Map(previousPlan.map((line) => [line.productId, line.rate]));
			const changedPrices: Array<{ productId: number; segmentId: string; rate: number }> = [];
			for (const line of lines) {
				const previousRate = previousByProduct.get(line.productId);
				const nextRate = Math.round(line.priceListRate * (1 - line.discountPercent / 100) * 100) / 100;
				if (previousRate !== undefined && Math.abs(nextRate - previousRate) >= 0.005) {
					changedPrices.push({ productId: line.productId, segmentId: 'base', rate: nextRate });
				}
			}
			if (changedPrices.length) await syncDealRealizationPrices(erp, dealId, changedPrices);
			let savedPlan: Awaited<ReturnType<typeof upsertDealPlan>>;
			try {
				savedPlan = await upsertDealPlan(erp, dealId, lines.map((l) => ({ productId: l.productId, qty: l.qty, priceListRate: l.priceListRate, discountPercent: l.discountPercent, isService: l.isService, ...(l.itemName ? { itemName: l.itemName } : {}), ...(l.lineKey ? { lineKey: l.lineKey } : {}) })), today);
				const transferAllocation = await supplyTransferAllocation(client, dealId);
				await syncSupplyRequestQuantitiesFromDeal(erp, { dealId, previousPlan, nextPlan: savedPlan.lines, transferAllocation });
			} catch (error) {
				await upsertDealPlan(erp, dealId, previousPlan, today).catch(() => undefined);
				if (changedPrices.length) {
					const rollbackPrices = changedPrices.flatMap(({ productId }) => {
						const previousRate = previousByProduct.get(productId);
						return previousRate === undefined ? [] : [{ productId, segmentId: 'base', rate: previousRate }];
					});
					await syncDealRealizationPrices(erp, dealId, rollbackPrices);
				}
				throw error;
			}
			const total = await calculateDealPlanTotal(erp, dealId);
			await setDealB24Service(client, dealId, total);
			await syncDealTechnicalFields(client, erp, dealId);
			app.log.info({ dealId, lines: savedPlan.lines.length, total }, '[api/deal/plan-set] ok');
			return { ok: true, total, lines: savedPlan.lines.length };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/plan-set] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
