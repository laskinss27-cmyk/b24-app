import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { fetchBasePrices, fetchServiceProductIds, legacyB24CompositionDisabled, setDealB24Service, VYEZD_PRODUCT_ID } from '../deal-product-catalog.js';
import { ErpClient } from '../erp/client.js';
import {
	appendDealStage,
	appendDealStageItems,
	assertDealQuoteVariantSelected,
	calculateDealPlanTotal,
	listDealPlan,
	listDealQuoteVariants,
	syncDealRealizationPrices,
	updateDealQuoteVariantItems,
	upsertDealPlan,
} from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealPlanDraftLine = {
	productId: number;
	itemName?: string;
	qty: number;
	priceListRate: number;
	discountPercent: number;
	isService?: boolean;
};

type DealClientFrom = (body: AuthBody) => B24Client | null;
type SyncDealTechnicalFields = (client: B24Client, erp: ErpClient, dealId: number) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealProductManagementRoutes(
	app: FastifyInstance,
	clientFrom: DealClientFrom,
	syncDealTechnicalFields: SyncDealTechnicalFields,
): void {
	// Добавить НЕСКОЛЬКО товарных строк в сделку за раз (корзина из пикера «Готово»).
	app.post('/api/deal/add-products', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown; stage?: unknown; stageId?: unknown; stageName?: unknown; variantId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = Array.isArray(b.items) ? b.items : [];
		const clean = items
			.map((it) => it as { productId?: unknown; quantity?: unknown; price?: unknown; name?: unknown; isService?: unknown })
			.map((it) => ({ productId: Number(it.productId), quantity: Number(it.quantity), price: Number(it.price), name: String(it.name ?? ''), isService: Boolean(it.isService) }))
			.filter((it) => Number.isInteger(it.productId) && it.productId > 0 && it.productId !== VYEZD_PRODUCT_ID && Number.isFinite(it.quantity) && it.quantity > 0);
		if (!clean.length) return reply.code(400).send({ ok: false, error: 'no valid items' });

		try {
			// Цены, которых нет в запросе, добираем из BASE одним батчем.
			const need = clean.filter((it) => !Number.isFinite(it.price) || it.price < 0).map((it) => it.productId);
			const [basePrices, serviceIds] = await Promise.all([
				need.length ? fetchBasePrices(client, need) : Promise.resolve(new Map<number, number>()),
				fetchServiceProductIds(client, clean.map((it) => it.productId)),
			]);
			const priced = clean.map((it) => ({ ...it, isService: it.isService || serviceIds.has(it.productId), price: Number.isFinite(it.price) && it.price >= 0 ? it.price : (basePrices.get(it.productId) ?? 0) }));

			const erp = ErpClient.fromEnv();
			if (!erp) throw new Error('ядро склада не подключено — состав сделки нельзя изменить');
			{
				const variantId = String(b.variantId ?? '').trim();
				if (variantId) {
					const state = await listDealQuoteVariants(erp, dealId);
					const variant = state.variants.find((row) => row.id === variantId);
					if (!variant) throw new Error('вариант КП не найден');
					const byId = new Map(variant.items.map((item) => [item.productId, { ...item }]));
					for (const item of priced) {
						const previous = byId.get(item.productId);
						if (previous) { previous.qty += item.quantity; previous.priceListRate = item.price; previous.isService = previous.isService || item.isService; }
						else byId.set(item.productId, { productId: item.productId, itemName: item.name || `#${item.productId}`, qty: item.quantity, priceListRate: item.price, discountPercent: 0, isService: item.isService });
					}
					const variantItems = [...byId.values()];
					await updateDealQuoteVariantItems(erp, dealId, variantId, variantItems);
					const total = Math.round(variantItems.reduce((sum, item) => sum + item.priceListRate * (1 - item.discountPercent / 100) * item.qty, 0) * 100) / 100;
					return { ok: true, added: priced.length, plan: variantItems.length, total };
				}
				await assertDealQuoteVariantSelected(erp, dealId);
				// ПОКРЫВАЛО: состав сделки → ПЛАН в ядре (Sales Order), а Б24 несёт ОДНУ свёрнутую
				// служебную строку с общей суммой. Новые товары мёржим в план по productId (кол-во суммируем).
				const byId = new Map<number, DealPlanDraftLine>();
				const targetStageId = String(b.stageId ?? '').trim();
				const addingToStage = Boolean(targetStageId) || b.stage === true;
				const currentPlan = await listDealPlan(erp, dealId);
				const initialLines = currentPlan.map((p) => ({
					productId: p.productId,
					itemName: p.itemName,
					qty: p.qty,
					priceListRate: p.priceListRate,
					discountPercent: p.discountPercent,
					isService: p.isService,
				}));
				for (const p of initialLines) byId.set(p.productId, p);
				for (const it of priced) {
					const prev = byId.get(it.productId);
					// Новый товар добавляется БЕЗ скидки. У существующего копим количество;
					// добавление в этап не должно менять цену основной строки этого товара.
					if (prev) {
						prev.qty += it.quantity;
						if (!addingToStage) prev.priceListRate = it.price;
						prev.isService = prev.isService || it.isService;
					}
					else byId.set(it.productId, { productId: it.productId, qty: it.quantity, priceListRate: it.price, discountPercent: 0, isService: it.isService, ...(it.name ? { itemName: it.name } : {}) });
				}
				const lines = [...byId.values()];
				const today = new Date().toISOString().slice(0, 10);
				const savedPlan = await upsertDealPlan(erp, dealId, lines, today);
				const stageItems = priced.map((item) => ({ productId: item.productId, itemName: item.name || `#${item.productId}`, qty: item.quantity, price: item.price, discountPercent: 0, isService: item.isService }));
				if (targetStageId) {
					await appendDealStageItems(erp, dealId, targetStageId, stageItems);
				} else if (b.stage === true) {
					const me = await client.call<{ ID?: unknown; NAME?: unknown; LAST_NAME?: unknown }>('user.current', {}).catch(() => null);
					const byName = [String(me?.['NAME'] ?? '').trim(), String(me?.['LAST_NAME'] ?? '').trim()].filter(Boolean).join(' ');
					const stageName = String(b.stageName ?? '').trim();
					if (stageName.length > 80) throw new Error('название этапа длиннее 80 символов');
					await appendDealStage(erp, dealId, {
						id: randomUUID(),
						...(stageName ? { name: stageName } : {}),
						at: new Date().toISOString(),
						byId: String(me?.['ID'] ?? ''),
						byName,
						items: stageItems,
					});
				}
				const total = await calculateDealPlanTotal(erp, dealId);
				await setDealB24Service(client, dealId, total);
				await syncDealTechnicalFields(client, erp, dealId);
				app.log.info({ dealId, planLines: savedPlan.lines.length, total }, '[api/deal/add-products] core plan + B24 service');
				return { ok: true, added: priced.length, plan: savedPlan.lines.length, total };
			}
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/add-products] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Удалить ОДНУ товарную строку из сделки по её rowId (crm.item.productrow.delete).
	app.post('/api/deal/remove-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; rowId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (legacyB24CompositionDisabled()) return reply.code(410).send({ ok: false, error: 'товарный состав сделки редактируется только в ядре' });
		const dealId = Number(b.dealId);
		const rowId = Number(b.rowId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(rowId) || rowId <= 0) return reply.code(400).send({ ok: false, error: 'bad rowId' });
		try {
			// Читаем текущие строки тем же API, что и таблица (productrows.get), убираем нужную по ID,
			// пересохраняем остальные (productrows.set) — гарантированно тот же id-простор, без рисков
			// расхождения нового/старого API. Пустой список = у сделки не остаётся товаров (ок).
			const rows = await client.call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
			const all = rows ?? [];
			const remaining = all.filter((r) => Number(r['ID']) !== rowId);
			if (remaining.length === all.length) return reply.code(404).send({ ok: false, error: 'строка не найдена' });
			const setRows = remaining.map((r) => ({
				PRODUCT_ID: Number(r['PRODUCT_ID'] ?? 0),
				PRODUCT_NAME: String(r['PRODUCT_NAME'] ?? ''),
				PRICE: Number(r['PRICE'] ?? 0),
				QUANTITY: Number(r['QUANTITY'] ?? 0),
				DISCOUNT_TYPE_ID: Number(r['DISCOUNT_TYPE_ID'] ?? 2),
				DISCOUNT_RATE: Number(r['DISCOUNT_RATE'] ?? 0),
				DISCOUNT_SUM: Number(r['DISCOUNT_SUM'] ?? 0),
				TAX_RATE: r['TAX_RATE'] ?? null,
				TAX_INCLUDED: String(r['TAX_INCLUDED'] ?? 'N'),
				MEASURE_CODE: Number(r['MEASURE_CODE'] ?? 796),
			}));
			await client.call('crm.deal.productrows.set', { id: dealId, rows: setRows });
			app.log.info({ dealId, rowId, left: setRows.length }, '[api/deal/remove-product] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ dealId, rowId }, `[api/deal/remove-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Изменить кол-во, БАЗОВУЮ цену и СКИДКУ % одной строки сделки. Тот же надёжный путь, что и удаление:
	// productrows.get → правим нужную строку → productrows.set всех (один id-простор).
	// Модель Б24: PRICE = итог за ед. (после скидки), DISCOUNT_SUM = скидка за ед., DISCOUNT_RATE = %.
	// База (без скидки) приходит от фронта в `price`; итог и скидку считаем тут.
	app.post('/api/deal/update-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; rowId?: unknown; quantity?: unknown; price?: unknown; discountRate?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (legacyB24CompositionDisabled()) return reply.code(410).send({ ok: false, error: 'товарный состав сделки редактируется только в ядре' });
		const dealId = Number(b.dealId);
		const rowId = Number(b.rowId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(rowId) || rowId <= 0) return reply.code(400).send({ ok: false, error: 'bad rowId' });
		const newQty = Number(b.quantity);
		const basePrice = Number(b.price);
		const rate = Number(b.discountRate);
		if (!Number.isFinite(newQty) || newQty <= 0) return reply.code(400).send({ ok: false, error: 'bad quantity' });
		if (!Number.isFinite(basePrice) || basePrice < 0) return reply.code(400).send({ ok: false, error: 'bad price' });
		if (!Number.isFinite(rate) || rate < 0 || rate > 100) return reply.code(400).send({ ok: false, error: 'bad discount' });
		const r2 = (n: number): number => Math.round(n * 100) / 100;
		const discSum = r2(basePrice * rate / 100); // скидка за единицу
		const finalPrice = r2(basePrice - discSum);  // итоговая цена за единицу
		try {
			const rows = await client.call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
			const all = rows ?? [];
			let found = false;
			let productId = 0;
			let previousFinalPrice = 0;
			const setRows = all.map((r) => {
				const isTarget = Number(r['ID']) === rowId;
				if (isTarget) {
					found = true;
					productId = Number(r['PRODUCT_ID'] ?? 0);
					previousFinalPrice = Number(r['PRICE'] ?? 0);
				}
				return {
					PRODUCT_ID: Number(r['PRODUCT_ID'] ?? 0),
					PRODUCT_NAME: String(r['PRODUCT_NAME'] ?? ''),
					PRICE: isTarget ? finalPrice : Number(r['PRICE'] ?? 0),
					QUANTITY: isTarget ? newQty : Number(r['QUANTITY'] ?? 0),
					DISCOUNT_TYPE_ID: isTarget ? 2 : Number(r['DISCOUNT_TYPE_ID'] ?? 2),
					DISCOUNT_RATE: isTarget ? rate : Number(r['DISCOUNT_RATE'] ?? 0),
					DISCOUNT_SUM: isTarget ? discSum : Number(r['DISCOUNT_SUM'] ?? 0),
					TAX_RATE: r['TAX_RATE'] ?? null,
					TAX_INCLUDED: String(r['TAX_INCLUDED'] ?? 'N'),
					MEASURE_CODE: Number(r['MEASURE_CODE'] ?? 796),
				};
			});
			if (!found) return reply.code(404).send({ ok: false, error: 'строка не найдена' });
			const erp = ErpClient.fromEnv();
			const priceChanged = Number.isInteger(productId) && productId > 0 && Math.abs(finalPrice - previousFinalPrice) >= 0.005;
			let realizationPriceSynced = false;
			if (erp && priceChanged) {
				await syncDealRealizationPrices(erp, dealId, [{ productId, segmentId: 'base', rate: finalPrice }]);
				realizationPriceSynced = true;
			}
			try {
				await client.call('crm.deal.productrows.set', { id: dealId, rows: setRows });
			} catch (error) {
				if (erp && realizationPriceSynced) {
					await syncDealRealizationPrices(erp, dealId, [{ productId, segmentId: 'base', rate: previousFinalPrice }]);
				}
				throw error;
			}
			app.log.info({ dealId, rowId, newQty, basePrice, rate, finalPrice }, '[api/deal/update-product] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ dealId, rowId }, `[api/deal/update-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});


	// Повторно записать в Б24 единственную служебную строку по сумме состава из ядра.
	app.post('/api/deal/collapse-service', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const erp = ErpClient.fromEnv();
			if (!erp) throw new Error('ядро склада не подключено — сумму сделки нельзя определить');
			const total = await calculateDealPlanTotal(erp, dealId);
			await setDealB24Service(client, dealId, total);
			app.log.info({ dealId, total }, '[api/deal/collapse-service] core total synchronized');
			return { ok: true, total };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/collapse-service] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

}
