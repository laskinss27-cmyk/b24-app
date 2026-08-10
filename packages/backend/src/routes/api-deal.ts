import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { appendDealStage, appendDealStageItems, calculateDealPlanTotal, syncDealRealizationPrices, upsertDealPlan, listDealPlan, listDealStages, listDealQuoteVariants, updateDealQuoteVariantItems, assertDealQuoteVariantSelected, type DealQuoteVariantItem } from '../erp/operations.js';
import { parseTransferItem } from '../transfers/model.js';
import {
	fetchBasePrices,
	fetchServiceProductIds,
	legacyB24CompositionDisabled,
	setDealB24Service,
	VYEZD_PRODUCT_ID,
} from '../deal-product-catalog.js';
import { syncDealFulfillmentStatus } from '../deal-fulfillment.js';
import { syncDealServiceSum } from '../deal-service-sum.js';
import { registerDealCoreRealizationRoute } from './deal-core-realization-route.js';
import { registerDealCommercialProposalFileRoutes } from './deal-commercial-proposal-file-routes.js';
import { registerDealCommercialProposalRoute } from './deal-commercial-proposal-route.js';
import { registerDealBitrixRealizationRoute } from './deal-bitrix-realization-route.js';
import { registerDealPlanExportRoute } from './deal-plan-export-route.js';
import { registerDealPlanProductReplacementRoute } from './deal-plan-product-replacement-route.js';
import { registerDealPlanRoute } from './deal-plan-route.js';
import { registerDealPlanUpdateRoute } from './deal-plan-update-route.js';
import { registerDealProductSearchRoute } from './deal-product-search-route.js';
import { registerDealQuoteVariantRoutes } from './deal-quote-variant-routes.js';
import { registerDealStageRoutes } from './deal-stage-routes.js';
import { registerDealSupplyRoutes } from './deal-supply-routes.js';
import { registerDealTechnicalFieldsRoute } from './deal-technical-fields-route.js';

/**
 * API вкладки сделки — «Добавить товар» (пункт 2) и «Реализовать» (черновик реализации).
 *  - /api/deal/search-products — поиск товара по названию (iblock 24+26) + розничная цена (BASE).
 *  - /api/deal/add-product — добавить ОДНУ товарную строку в сделку (crm.item.productrow.add,
 *    ownerType='D'); существующие строки НЕ трогаются (не set-all). Проверено net-zero.
 *  - /api/deal/realize — ЧЕРНОВИК-ПАРТИЯ реализации по отмеченным строкам сделки (цикл пробит
 *    2026-06-11, партии — по нативной модели «один заказ → много отгрузок», как #558/2,/3,/4):
 *    storeId в crm-строки → заказ сделки ПЕРЕИСПОЛЬЗУЕМ (crm.orderentity.list по ownerId), если
 *    нет — sale.order.add + снос свежего дубль-сделки/контакта + crm.orderentity.add → корзина
 *    с xmlId=crm_pr_<rowId> и ПОЛНЫМ кол-вом строки → sale.shipment.add черновиком с ЧАСТИЧНЫМ
 *    кол-вом партии (deducted=N — СКЛАД НЕ ДВИГАЕМ). Проводит менеджер в нативном UI.
 *  - /api/deal/shipped — что уже отгружено по строкам сделки (по партиям заказа сделки)
 *    + заявки снабжения сделки (смарт-процесс «Снабжение» 1110).
 *  - /api/deal/supply-request — товар «нет на складах» → в снабжение: дополняет перечень
 *    существующей заявки сделки или создаёт карточку 1110 «Поставка № N_<сделка>_<название>»
 *    с ТОЧНЫМ перечнем (имя × кол-во) — лучше родного робота, который перечень не заполняет.
 *    Робот на дубль не пойдёт: ставим на сделке галку «Заявка снабжения создана».
 *
 * ЗАПИСЬ в сделку, но безопасная и обратимая (менеджер удалит строку в карточке).
 * Токен — самого юзера (права Битрикса соблюдаются). Домен — allowlist. За канарейкой (фронт).
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}


type DealPlanDraftLine = {
	productId: number;
	itemName?: string;
	qty: number;
	priceListRate: number;
	discountPercent: number;
	isService?: boolean;
};



export function registerApiDealRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};
	const supplyTransferAllocation = async (client: B24Client, dealId: number): Promise<Map<string, Map<number, number>>> => {
		await ensureTransfersEntity(client);
		const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
		const result = new Map<string, Map<number, number>>();
		for (const transfer of (items ?? []).map(parseTransferItem).filter((item) => item?.dealId === String(dealId))) {
			if (!transfer || transfer.correctionOf || transfer.purchaseOrder || transfer.status === 'canceled' || !transfer.supplyRequestKey) continue;
			const byProduct = result.get(transfer.supplyRequestKey) ?? new Map<number, number>();
			for (const line of transfer.lines) byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + line.qty);
			result.set(transfer.supplyRequestKey, byProduct);
		}
		return result;
	};
	const syncDealTechnicalFields = async (client: B24Client, erp: ErpClient, dealId: number): Promise<void> => {
		try {
			const result = await syncDealFulfillmentStatus(client, erp, dealId);
			app.log.info({ dealId, ...result }, '[deal-fulfillment] synchronized');
		} catch (err) {
			app.log.error({ dealId }, `[deal-fulfillment] synchronization failed — ${errInfo(err)}`);
		}
		try {
			const result = await syncDealServiceSum(client, erp, dealId);
			app.log.info({ dealId, ...result }, '[deal-service-sum] synchronized');
		} catch (err) {
			app.log.error({ dealId }, `[deal-service-sum] synchronization failed — ${errInfo(err)}`);
		}
	};

	registerDealTechnicalFieldsRoute(app, clientFrom);

	registerDealCoreRealizationRoute(app, clientFrom, syncDealTechnicalFields);

	registerDealProductSearchRoute(app, clientFrom);

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

	registerDealPlanRoute(app, clientFrom);

	registerDealStageRoutes(app, clientFrom, syncDealTechnicalFields);

	registerDealQuoteVariantRoutes(app, clientFrom, syncDealTechnicalFields);

	registerDealPlanUpdateRoute(app, clientFrom, supplyTransferAllocation, syncDealTechnicalFields);

	registerDealPlanExportRoute(app, clientFrom);

	registerDealPlanProductReplacementRoute(app, clientFrom, supplyTransferAllocation, syncDealTechnicalFields);

	registerDealCommercialProposalRoute(app, clientFrom);
	registerDealCommercialProposalFileRoutes(app, clientFrom);

	registerDealSupplyRoutes(app, clientFrom);

	registerDealBitrixRealizationRoute(app, clientFrom);

	// Добавить одну товарную строку в сделку (не перезаписывая существующие).
	app.post('/api/deal/add-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; productId?: unknown; quantity?: unknown; price?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (legacyB24CompositionDisabled()) return reply.code(410).send({ ok: false, error: 'товарный состав сделки редактируется только в ядре' });

		const dealId = Number(b.dealId);
		const productId = Number(b.productId);
		const quantity = Number(b.quantity);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		if (!Number.isFinite(quantity) || quantity <= 0) return reply.code(400).send({ ok: false, error: 'bad quantity' });

		try {
			// Цена: из запроса (если задана) или розничная BASE.
			let price = Number(b.price);
			if (!Number.isFinite(price) || price < 0) price = (await fetchBasePrices(client, [productId])).get(productId) ?? 0;

			const res = await client.call<{ productRow?: Record<string, unknown> }>('crm.item.productrow.add', {
				fields: { ownerType: 'D', ownerId: dealId, productId, price, quantity },
			});
			const row = res?.productRow;
			app.log.info({ dealId, productId, quantity }, '[api/deal/add-product] ok');
			return { ok: true, row: { id: Number(row?.['id']), name: String(row?.['productName'] ?? ''), price: Number(row?.['price'] ?? price), quantity: Number(row?.['quantity'] ?? quantity) } };
		} catch (err) {
			app.log.error({ dealId, productId }, `[api/deal/add-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
