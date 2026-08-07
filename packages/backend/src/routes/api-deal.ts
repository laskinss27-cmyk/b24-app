import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureRealizeEntity, ensureTransfersEntity, REALIZE_ENTITY, TRANSFERS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { appendDealStage, appendDealStageItems, calculateDealPlanTotal, createRealizationDraft, fetchErpStocksFor, submitRealization, listDealRealizations, createClientReturns, reduceDealPlanForReturns, syncDealRealizationPrices, upsertDealPlan, listDealPlan, listDealStages, listSupplyRequestsForDeal, listDealQuoteVariants, updateDealQuoteVariantItems, assertDealQuoteVariantSelected, type DealQuoteVariantItem } from '../erp/operations.js';
import { parseTransferItem } from '../transfers/model.js';
import { loadDealOrderInfo } from '../deal-order-info.js';
import {
	CORE_ENGINEER_VISIT_SERVICE_ID,
	fetchBasePrices,
	fetchServiceProductIds,
	legacyB24CompositionDisabled,
	setDealB24Service,
	VYEZD_PRODUCT_ID,
} from '../deal-product-catalog.js';
import { syncDealFulfillmentStatus } from '../deal-fulfillment.js';
import { syncDealServiceSum } from '../deal-service-sum.js';
import { registerDealCommercialProposalFileRoutes } from './deal-commercial-proposal-file-routes.js';
import { registerDealCommercialProposalRoute } from './deal-commercial-proposal-route.js';
import { registerDealPlanExportRoute } from './deal-plan-export-route.js';
import { registerDealPlanProductReplacementRoute } from './deal-plan-product-replacement-route.js';
import { registerDealPlanRoute } from './deal-plan-route.js';
import { registerDealPlanUpdateRoute } from './deal-plan-update-route.js';
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

	// РЕАЛИЗАЦИЯ В ЯДРЕ (Delivery Note) — «покрывало»: складской документ живёт в ERPNext, не в Б24.
	// action='list': что уже реализовано по сделке (из ядра по b24_deal_id) — черновики + проведённые;
	// action='draft': по каждому складу-группе создаём черновик Delivery Note (b24_deal_id, реальный склад);
	// action='submit': проводим переданные черновики (docstatus 1) → остаток ядра реально списывается.
	// Один документ на склад (группировка на фронте). «День X» (синк перестаёт затирать) — отдельно.
	app.post('/api/deal/realize-core', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; action?: unknown; groups?: unknown; names?: unknown; note?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		const action = String(b.action ?? '');
		try {
			if (action === 'list') {
				// Что уже реализовано по сделке — из ЯДРА (Delivery Note по b24_deal_id), а не из
				// битриксовых отгрузок. Возвращает и черновики (docstatus 0), и проведённые (1).
				const dealId = Number(b.dealId);
				if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
				const realizations = await listDealRealizations(erp, dealId);
				return { ok: true, realizations };
			}
			if (action === 'draft') {
				const dealId = Number(b.dealId);
				if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
				await assertDealQuoteVariantSelected(erp, dealId);
				const groups = Array.isArray(b.groups) ? b.groups : [];
				const requestedProductIds = groups.flatMap((g) => {
					const gg = g as { lines?: unknown };
					return (Array.isArray(gg.lines) ? gg.lines : []).map((line) => Number((line as { productId?: unknown }).productId)).filter((id) => Number.isInteger(id) && id > 0);
				});
				// Тип строки определяем на сервере, а не доверяем флагу клиента: товар нельзя
				// выдать за услугу, чтобы обойти склад и проверку остатка.
				const [dealPlan, dealStages, catalogServiceIds] = await Promise.all([
					listDealPlan(erp, dealId).catch(() => []),
					listDealStages(erp, dealId).catch(() => []),
					fetchServiceProductIds(client, requestedProductIds),
				]);
				const serviceIds = new Set([
					...dealPlan.filter((item) => item.isService).map((item) => item.productId),
					...catalogServiceIds,
				]);
				const validStageSegments = new Set(dealStages.flatMap((stage) =>
					stage.items.map((item) => `${item.productId}\u0000stage:${stage.id}`)));
				const parsedGroups = groups.map((g) => {
					const gg = g as { storeTitle?: unknown; lines?: unknown };
					const storeTitle = String(gg.storeTitle ?? '').trim();
					const lines = (Array.isArray(gg.lines) ? gg.lines : [])
						.map((l) => l as { productId?: unknown; qty?: unknown; rate?: unknown; segmentId?: unknown })
						.map((l) => {
							const productId = Number(l.productId);
							const isService = serviceIds.has(productId);
							const segmentId = String(l.segmentId ?? 'base').trim() || 'base';
							return { productId, qty: Number(l.qty), rate: Number(l.rate) || 0, segmentId, ...(storeTitle ? { storeTitle } : {}), isService };
						})
						.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
					return { storeTitle, lines };
				}).filter((group) => group.lines.length);
				for (const group of parsedGroups) for (const line of group.lines) {
					if (!line.isService && !group.storeTitle) throw new Error(`для товара #${line.productId} не выбран склад реализации`);
					if (line.segmentId !== 'base' && !validStageSegments.has(`${line.productId}\u0000${line.segmentId}`)) {
						throw new Error(`этап реализации для позиции #${line.productId} не найден`);
					}
				}
				await ensureTransfersEntity(client);
				const transferItems = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
				const reserved = new Map<string, number>();
				for (const transfer of (transferItems ?? []).map(parseTransferItem).filter((item) => item && (item.status === 'draft' || item.status === 'collected' || item.status === 'requested'))) {
					for (const line of transfer!.lines) {
						const key = `${line.productId}:${transfer!.fromStore}`;
						reserved.set(key, (reserved.get(key) ?? 0) + line.qty);
					}
				}
				const productIds = parsedGroups.flatMap((group) => group.lines.filter((line) => !line.isService).map((line) => line.productId));
				const stocks = await fetchErpStocksFor(erp, productIds);
				for (const group of parsedGroups) for (const line of group.lines) {
					if (line.isService) continue;
					const available = Math.max(Number(stocks.get(line.productId)?.[group.storeTitle] ?? 0) - (reserved.get(`${line.productId}:${group.storeTitle}`) ?? 0), 0);
					if (line.qty > available + 0.000001) throw new Error(`на складе «${group.storeTitle}» для товара #${line.productId} свободно ${available}, к реализации выбрано ${line.qty}`);
				}
				const drafts: Array<{ name: string; storeTitle: string }> = [];
				for (const { storeTitle, lines } of parsedGroups) {
					if (!lines.length) continue;
					const { name } = await createRealizationDraft(erp, { dealId, lines });
					drafts.push({ name, storeTitle: storeTitle || 'Услуги' });
				}
				if (!drafts.length) return reply.code(400).send({ ok: false, error: 'нет валидных строк для реализации' });
				app.log.info({ dealId, drafts: drafts.length }, '[api/deal/realize-core] drafts created');
				return { ok: true, drafts };
			}
			if (action === 'return') {
				const dealId = Number(b.dealId);
				if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
				// Возврат доступен менеджеру только в сделке, к которой Битрикс даёт ему доступ.
				// Проверяем это до создания складских документов, чтобы не расширять прочие права пользователя.
				await client.call('crm.deal.get', { id: dealId });
				await assertDealQuoteVariantSelected(erp, dealId);
				const note = String(b.note ?? '').trim();
				const lines = (Array.isArray(b.lines) ? b.lines : [])
					.map((l) => l as { productId?: unknown; qty?: unknown; store?: unknown })
					.map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), storeTitle: String(l.store ?? '').trim() }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0 && l.storeTitle);
				if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций возврата' });
				const { names, returned } = await createClientReturns(erp, { dealId, ...(note ? { note } : {}), lines });
				// Возвращённый товар больше не должен снова появляться в сделке как неотгруженный.
				// Уменьшаем именно основную строку или конкретный этап, из которого был возврат.
				const today = new Date().toISOString().slice(0, 10);
				const savedPlan = await reduceDealPlanForReturns(erp, dealId, returned, today);
				const total = await calculateDealPlanTotal(erp, dealId);
				await setDealB24Service(client, dealId, total);
				await syncDealTechnicalFields(client, erp, dealId);
				app.log.info({ dealId, returns: names.length, planLines: savedPlan.length, total }, '[api/deal/realize-core] returns created, deal plan reduced');
				return { ok: true, returns: names };
			}
			if (action === 'submit') {
				const dealId = Number(b.dealId);
				if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
				const names = (Array.isArray(b.names) ? b.names : []).map(String).filter((n) => n && n !== 'undefined');
				if (!names.length) return reply.code(400).send({ ok: false, error: 'нет документов для проведения' });
				const dealDocuments = await listDealRealizations(erp, dealId);
				const allowedDrafts = new Set(dealDocuments.filter((document) => !document.submitted).map((document) => document.name));
				if (names.some((name) => !allowedDrafts.has(name))) throw new Error('один из черновиков не принадлежит этой сделке или уже проведён');
				const submitted: string[] = [];
				for (const name of names) { await submitRealization(erp, name); submitted.push(name); }
				await syncDealTechnicalFields(client, erp, dealId);
				app.log.info({ dealId, submitted: submitted.length }, '[api/deal/realize-core] submitted');
				return { ok: true, submitted };
			}
			return reply.code(400).send({ ok: false, error: 'bad action' });
		} catch (err) {
			app.log.error({ action }, `[api/deal/realize-core] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Поиск товара по названию + розничная цена (для пикера «Добавить товар»).
	app.post('/api/deal/search-products', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { q?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const q = String(b.q ?? '').trim();
		if (q.length < 2) return { ok: true, products: [] as Array<{ id: number; name: string; price: number }> };
		try {
			const byName = new Map<string, { id: number; name: string }>();
			for (const iblockId of [24, 26]) {
				const res = await client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
					filter: { iblockId, '%name': q },
					select: ['id', 'iblockId', 'name'], // iblockId обязателен в select
					order: { id: 'ASC' },
				});
				for (const p of res?.products ?? []) {
					const name = String(p['name'] ?? '');
					const id = Number(p['id']);
					if (id === VYEZD_PRODUCT_ID) continue;
					if (name && id > 0 && !byName.has(name)) byName.set(name, { id, name });
				}
			}
			const list = [...byName.values()];
			if ('выезд инженера'.includes(q.toLowerCase()) || q.toLowerCase().includes('выезд') || q.toLowerCase().includes('инженер')) {
				list.unshift({ id: CORE_ENGINEER_VISIT_SERVICE_ID, name: 'Выезд инженера' });
			}
			const limited = list.slice(0, 30);
			const prices = await fetchBasePrices(client, limited.filter((p) => p.id !== CORE_ENGINEER_VISIT_SERVICE_ID).map((p) => p.id));
			const products = limited.map((p) => ({ ...p, price: p.id === CORE_ENGINEER_VISIT_SERVICE_ID ? 0 : (prices.get(p.id) ?? 0) }));
			app.log.info({ count: products.length }, '[api/deal/search-products] ok');
			return { ok: true, products };
		} catch (err) {
			app.log.error({}, `[api/deal/search-products] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

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

	// ЧЕРНОВИК-ПАРТИЯ реализации по отмеченным строкам сделки. Нативная модель «один заказ →
	// много отгрузок»: заказ сделки переиспользуем, каждая партия = новый черновик отгрузки
	// с частичным количеством. При ошибке на полпути НИЧЕГО не откатываем — возвращаем createdIds
	// для ручной зачистки (правило Сергея; исключение — свежерождённый дубль, см. ниже).
	app.post('/api/deal/realize', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = (Array.isArray(b.items) ? b.items : [])
			.map((it) => it as { rowId?: unknown; productId?: unknown; quantity?: unknown; rowQuantity?: unknown; price?: unknown; name?: unknown; storeId?: unknown })
			.map((it) => ({
				rowId: Number(it.rowId),
				productId: Number(it.productId),
				/** Кол-во ЭТОЙ партии (может быть меньше количества в строке сделки). */
				quantity: Number(it.quantity),
				/** Полное кол-во строки сделки — таким создаётся строка корзины заказа. */
				rowQuantity: Number(it.rowQuantity ?? it.quantity),
				price: Number(it.price),
				name: String(it.name ?? ''),
				storeId: Number(it.storeId ?? 0),
				storeName: String((it as { storeName?: unknown }).storeName ?? ''),
			}))
			.filter((it) =>
				Number.isInteger(it.rowId) && it.rowId > 0 &&
				Number.isInteger(it.productId) && it.productId > 0 &&
				Number.isFinite(it.quantity) && it.quantity > 0 &&
				Number.isFinite(it.rowQuantity) && it.rowQuantity >= it.quantity &&
				Number.isFinite(it.price) && it.price >= 0);
		if (!items.length) return reply.code(400).send({ ok: false, error: 'no valid items' });

		// Создаваемое по шагам — чтобы при ошибке вернуть Сергею точный список артефактов.
		const created: { orderId?: number; orderReused?: boolean; shipmentId?: number; basketIds: number[]; dupDealId?: number; dupContactId?: number } = { basketIds: [] };
		const step = (s: string): void => { app.log.info({ dealId }, `[api/deal/realize] ${s}`); };
		try {
			// 0) Менеджер (userId заказа у нативных реализаций = сотрудник, не клиент — разведка 2026-06-11).
			const me = await client.call<{ ID?: string | number }>('user.current', {});
			const userId = Number(me?.ID ?? 0);
			if (!userId) throw new Error('user.current не вернул ID');

			// 1) Сделка: валюта + контакт (для свойств заказа «Имя Фамилия»/«Телефон»).
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const currency = String(deal?.['CURRENCY_ID'] ?? 'RUB') || 'RUB';
			const contactId = Number(deal?.['CONTACT_ID'] ?? 0);
			let clientName = '';
			let clientPhone = '';
			if (contactId > 0) {
				const ct = await client.call<Record<string, unknown>>('crm.contact.get', { id: contactId }).catch(() => null);
				clientName = [ct?.['NAME'], ct?.['LAST_NAME']].filter(Boolean).join(' ').trim();
				const phones = ct?.['PHONE'] as Array<{ VALUE?: string }> | undefined;
				clientPhone = String(phones?.[0]?.VALUE ?? '');
			}

			// 2) Склад ЭТОЙ партии в строки сделки — МЯГКО: живой тест 2026-06-11 показал, что
			//    crm.item.productrow.update поле storeId НЕ принимает (INVALID_ARG_VALUE: Field
			//    'storeId' not available for update) — нативный механизм пишет его изнутри.
			//    Пробуем на каждый случай (вдруг откроют), но кнопка от этого НЕ падает:
			//    склад партии живёт в нашей памяти (entity), а в черновике его выбирает менеджер.
			let storesWritten = 0;
			for (const it of items.filter((x) => Number.isInteger(x.storeId) && x.storeId > 0)) {
				try {
					await client.call('crm.item.productrow.update', { id: it.rowId, fields: { storeId: it.storeId } });
					storesWritten++;
				} catch (err) {
					app.log.warn({ rowId: it.rowId }, `[api/deal/realize] storeId в строку не записался (ожидаемо, поле read-only) — ${errInfo(err)}`);
				}
			}
			if (storesWritten > 0) step(`storeId записан в ${storesWritten} строк`);

			// 3) Текущее состояние: заказ сделки, корзина crm_pr_, отгружено по партиям.
			const info = await loadDealOrderInfo(client, dealId);
			let orderId = info.orderId;

			// 3а) Контроль остатков ДО любой записи: партия не должна превышать «строка − отгружено».
			for (const it of items) {
				const already = info.shipped.get(it.rowId) ?? 0;
				if (already + it.quantity > it.rowQuantity + 1e-9) {
					throw new Error(`строка «${it.name || it.rowId}»: к отгрузке ${it.quantity} + уже отгружено ${already} больше количества в сделке ${it.rowQuantity}`);
				}
			}

			if (orderId) {
				created.orderReused = true;
				step(`заказ сделки уже есть (${orderId}) — переиспользую, партия добавится отгрузкой`);
			} else {
				// 4) Заказ. ВАЖНО: поле currency (НЕ currencyId); externalOrder=Y от дубля не спасает, но не мешает.
				const ord = await client.call<{ order?: { id?: number } }>('sale.order.add', {
					fields: { lid: 's1', personTypeId: 6, currency, userId, externalOrder: 'Y' },
				});
				orderId = Number(ord?.order?.id);
				if (!orderId) throw new Error('sale.order.add не вернул id заказа');
				created.orderId = orderId;
				step(`заказ ${orderId}`);

				// 5) Портал авто-рождает дубль-сделку+контакт на каждый sale.order.add — сносим ИМЕННО их.
				//    Гарантии: дубль берём только из авто-привязки этого заказа, чужие ID не трогаем,
				//    и только если сделка создана в последние 15 минут (страховка от любого промаха).
				const bnd = await client.call<{ orderEntity?: Array<Record<string, unknown>> }>('crm.orderentity.list', { filter: { orderId }, select: ['*'] }).catch(() => null);
				const dup = (bnd?.orderEntity ?? []).find((x) => Number(x['ownerTypeId']) === 2 && Number(x['ownerId']) !== dealId);
				if (dup) {
					const dupId = Number(dup['ownerId']);
					const dupDeal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dupId }).catch(() => null);
					const bornMs = Date.parse(String(dupDeal?.['DATE_CREATE'] ?? ''));
					const fresh = Number.isFinite(bornMs) && Date.now() - bornMs < 15 * 60 * 1000;
					if (fresh) {
						const dupContact = Number(dupDeal?.['CONTACT_ID'] ?? 0);
						await client.call('crm.orderentity.deleteByFilter', { fields: { orderId, ownerId: dupId, ownerTypeId: 2 } }).catch(() => null);
						await client.call('crm.deal.delete', { id: dupId });
						created.dupDealId = dupId;
						if (dupContact > 0 && dupContact !== contactId) {
							await client.call('crm.contact.delete', { id: dupContact }).catch(() => null);
							created.dupContactId = dupContact;
						}
						step(`дубль-сделка ${dupId} (+контакт ${dupContact || '—'}) снесена`);
					} else {
						app.log.warn({ dealId, dupId }, '[api/deal/realize] привязка к НЕ свежей сделке — не трогаю');
					}
				}

				// 6) Привязка заказа к НАШЕЙ сделке (стена 1 пробита: метод скрыт из `methods`, но работает).
				await client.call('crm.orderentity.add', { fields: { orderId, ownerId: dealId, ownerTypeId: 2 } });
				step(`orderentity → сделка ${dealId}`);
			}

			// 7) Свойства заказа (клиент в документе) — ПРИ КАЖДОЙ партии, а не только при создании
			//    заказа: контакт сделки мог появиться/смениться ПОСЛЕ рождения заказа (живой баг
			//    2026-06-12 «клиент = CONTACT_16332»: заказ родился у сделки без контакта, сегодняшняя
			//    партия его переиспользовала — блок в ветке создания не выполнялся). Источник правды —
			//    контакт сделки. Формат подтверждён живьём (test-propertyvalue-modify.ts, заказ 966).
			if (clientName || clientPhone) {
				const propertyValues: Array<{ orderPropsId: number; value: string }> = [];
				if (clientName) propertyValues.push({ orderPropsId: 40, value: clientName });
				if (clientPhone) propertyValues.push({ orderPropsId: 44, value: clientPhone });
				await client.call('sale.propertyvalue.modify', { fields: { order: { id: orderId, propertyValues } } })
					.then(() => step('свойства клиента записаны'))
					.catch((err) => app.log.warn({ orderId }, `[api/deal/realize] propertyvalue.modify не прошёл (не критично) — ${errInfo(err)}`));
			}

			// 8) Корзина: строка корзины несёт ПОЛНОЕ кол-во строки сделки (xmlId=crm_pr_<rowId>,
			//    структура неотличима от нативной); партии разбирают её частями — остаток Битрикс
			//    сам держит на системной отгрузке. Существующие строки переиспользуем.
			const basketByRow = new Map<number, { basketId: number }>();
			for (const it of items) {
				const existing = info.basket.get(it.rowId);
				if (existing) {
					// Строка уже в заказе. Если её кол-ва не хватает на партию — дотягиваем.
					const already = info.shipped.get(it.rowId) ?? 0;
					if (already + it.quantity > existing.quantity + 1e-9) {
						await client.call('sale.basketitem.update', { id: existing.basketId, fields: { quantity: already + it.quantity } });
						step(`корзина ${existing.basketId}: кол-во увеличено до ${already + it.quantity}`);
					}
					basketByRow.set(it.rowId, { basketId: existing.basketId });
					continue;
				}
				const bi = await client.call<{ basketItem?: { id?: number } }>('sale.basketitem.add', {
					fields: { orderId, productId: it.productId, quantity: it.rowQuantity, price: it.price, currency, name: it.name || `Товар ${it.productId}`, xmlId: `crm_pr_${it.rowId}` },
				});
				const basketId = Number(bi?.basketItem?.id);
				if (!basketId) throw new Error(`sale.basketitem.add не вернул id (строка ${it.rowId})`);
				created.basketIds.push(basketId);
				basketByRow.set(it.rowId, { basketId });
			}
			step(`корзина: ${basketByRow.size} строк (новых ${created.basketIds.length})`);

			// 9) Черновик-партия (deliveryId 6 = «Без доставки» на этом портале; deducted=N — склад не тронут).
			const sh = await client.call<{ shipment?: Record<string, unknown> }>('sale.shipment.add', {
				fields: { orderId, deliveryId: 6, allowDelivery: 'N', deducted: 'N' },
			});
			const shipmentId = Number(sh?.shipment?.['id']);
			if (!shipmentId) throw new Error('sale.shipment.add не вернул id');
			created.shipmentId = shipmentId;
			const accountNumber = String(sh?.shipment?.['accountNumber'] ?? '');
			for (const it of items) {
				const basketId = basketByRow.get(it.rowId)?.basketId;
				if (!basketId) continue;
				await client.call('sale.shipmentitem.add', { fields: { orderDeliveryId: shipmentId, basketId, quantity: it.quantity } });
			}
			step(`черновик-партия #${accountNumber} (shipment ${shipmentId}) готов`);

			// 10) Память складов партии (entity) — мягко: упадёт — партия живёт, просто без подписи склада.
			const stores: Record<string, { storeId: number; storeName: string }> = {};
			for (const it of items) if (it.storeId > 0) stores[String(it.rowId)] = { storeId: it.storeId, storeName: it.storeName };
			if (Object.keys(stores).length) {
				try {
					await ensureRealizeEntity(client);
					await client.call('entity.item.add', {
						ENTITY: REALIZE_ENTITY,
						NAME: `ship_${shipmentId}`,
						DETAIL_TEXT: JSON.stringify({ dealId, orderId, shipmentId, stores }),
					});
					step('склады партии записаны в память приложения');
				} catch (err) {
					app.log.warn({ shipmentId }, `[api/deal/realize] память складов не записалась (не критично) — ${errInfo(err)}`);
				}
			}

			return { ok: true, orderId, orderReused: created.orderReused ?? false, shipmentId, accountNumber, dupRemoved: created.dupDealId ?? null };
		} catch (err) {
			app.log.error({ dealId, created }, `[api/deal/realize] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), created });
		}
	});

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
