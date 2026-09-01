import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { fetchServiceProductIds, setDealB24Service } from '../deal-product-catalog.js';
import { ErpClient } from '../erp/client.js';
import {
	assertDealQuoteVariantSelected,
	calculateDealPlanTotal,
	createClientReturns,
	createRealizationDraft,
	fetchErpStocksFor,
	listDealPlan,
	listDealRealizations,
	listDealStages,
	reduceDealPlanForReturns,
	submitRealization,
} from '../erp/operations.js';
import { parseTransferItem } from '../transfers/model.js';
import { recordRealizationEvent } from '../operation-log/realization-events.js';
import { ReservationService } from '../reservations/service.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;
type SyncDealTechnicalFields = (client: B24Client, erp: ErpClient, dealId: number) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealCoreRealizationRoute(
	app: FastifyInstance,
	clientFrom: DealClientFrom,
	syncDealTechnicalFields: SyncDealTechnicalFields,
): void {
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
		const logDealId = Number(b.dealId);
		const loggedDocuments: string[] = [];
		try {
			const reservationService = app.reservationRuntime ? new ReservationService(app.reservationRuntime) : null;
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
				const transferItems = await listAllEntityItems(client, TRANSFERS_ENTITY);
				const reserved = new Map<string, number>();
				for (const transfer of (transferItems ?? []).map(parseTransferItem).filter((item) => item && (item.status === 'draft' || item.status === 'collected' || item.status === 'requested'))) {
					for (const line of transfer!.lines) {
						const key = `${line.productId}:${transfer!.fromStore}`;
						reserved.set(key, (reserved.get(key) ?? 0) + line.qty);
					}
				}
				const productIds = parsedGroups.flatMap((group) => group.lines.filter((line) => !line.isService).map((line) => line.productId));
				const [stocks, sqlAvailability] = await Promise.all([
					fetchErpStocksFor(erp, productIds),
					reservationService?.availabilityForDeal(erp, dealId, parsedGroups.flatMap((group) =>
						group.lines.filter((line) => !line.isService).map((line) => ({ productId: line.productId, storeTitle: group.storeTitle })),
					)) ?? [],
				]);
				const sqlByKey = new Map(sqlAvailability.map((line) => [`${line.productId}:${line.storeTitle}`, line]));
				for (const group of parsedGroups) for (const line of group.lines) {
					if (line.isService) continue;
					const sqlReserved = app.reservationRuntime?.canWrite ? (sqlByKey.get(`${line.productId}:${group.storeTitle}`)?.reservedByOthers ?? 0) : 0;
					const available = Math.max(Number(stocks.get(line.productId)?.[group.storeTitle] ?? 0) - (reserved.get(`${line.productId}:${group.storeTitle}`) ?? 0) - sqlReserved, 0);
					if (line.qty > available + 0.000001) throw new Error(`на складе «${group.storeTitle}» для товара #${line.productId} свободно ${available}, к реализации выбрано ${line.qty}`);
				}
				const drafts: Array<{ name: string; storeTitle: string }> = [];
				for (const { storeTitle, lines } of parsedGroups) {
					if (!lines.length) continue;
					const { name } = await createRealizationDraft(erp, { dealId, lines });
					drafts.push({ name, storeTitle: storeTitle || 'Услуги' });
					loggedDocuments.push(name);
				}
				if (!drafts.length) return reply.code(400).send({ ok: false, error: 'нет валидных строк для реализации' });
				app.log.info({ dealId, drafts: drafts.length }, '[api/deal/realize-core] drafts created');
				await recordRealizationEvent(app, req, { operation: 'draft', dealId, documents: loggedDocuments });
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
				loggedDocuments.push(...names);
				// Возвращённый товар больше не должен снова появляться в сделке как неотгруженный.
				// Уменьшаем именно основную строку или конкретный этап, из которого был возврат.
				const today = new Date().toISOString().slice(0, 10);
				const savedPlan = await reduceDealPlanForReturns(erp, dealId, returned, today);
				const total = await calculateDealPlanTotal(erp, dealId);
				await setDealB24Service(client, dealId, total);
				await syncDealTechnicalFields(client, erp, dealId);
				app.log.info({ dealId, returns: names.length, planLines: savedPlan.length, total }, '[api/deal/realize-core] returns created, deal plan reduced');
				await recordRealizationEvent(app, req, { operation: 'return', dealId, documents: loggedDocuments });
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
				const reservationWarnings: string[] = [];
				const me = reservationService?.canWrite
					? await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {})
					: null;
				for (const name of names) {
					await submitRealization(erp, name);
					submitted.push(name);
					loggedDocuments.push(name);
					const document = dealDocuments.find((candidate) => candidate.name === name);
					if (reservationService?.canWrite && me && document) {
						try {
							await reservationService.consumeDealRealization(erp, {
								id: String(me.ID ?? ''), name: `${String(me.LAST_NAME ?? '').trim()} ${String(me.NAME ?? '').trim()}`.trim(),
							}, dealId, name, document.items
								.filter((item) => item.storeTitle && item.qty > 0)
								.map((item) => ({ productId: item.productId, storeTitle: item.storeTitle, quantity: item.qty })));
						} catch (reservationError) {
							const warning = `резерв по ${name} требует сверки: ${errInfo(reservationError)}`;
							reservationWarnings.push(warning);
							app.log.error({ dealId, name }, `[reservations] ${warning}`);
						}
					}
				}
				await syncDealTechnicalFields(client, erp, dealId);
				app.log.info({ dealId, submitted: submitted.length }, '[api/deal/realize-core] submitted');
				await recordRealizationEvent(app, req, { operation: 'submit', dealId, documents: loggedDocuments });
				return { ok: true, submitted, reservationWarnings };
			}
			return reply.code(400).send({ ok: false, error: 'bad action' });
		} catch (err) {
			const error = errInfo(err);
			app.log.error({ action }, `[api/deal/realize-core] failed — ${error}`);
			if ((action === 'draft' || action === 'submit' || action === 'return') && Number.isInteger(logDealId) && logDealId > 0) {
				await recordRealizationEvent(app, req, { operation: action, dealId: logDealId, documents: loggedDocuments, error });
			}
			return reply.code(200).send({ ok: false, error });
		}
	});
}
