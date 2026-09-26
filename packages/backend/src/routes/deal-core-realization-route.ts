import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { appPermission } from '../access-policy.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { fetchServiceProductIds } from '../deal-product-catalog.js';
import { dealProductIdFromCoreItemCode } from '../deal-service-product-ids.js';
import { ErpClient } from '../erp/client.js';
import { DEAL_FIELD } from '../erp/erp-setup.js';
import {
	assertDealQuoteVariantSelected,
	createRealizationDraft,
	deleteRealizationDraft,
	fetchErpStocksFor,
	listDealPlan,
	listDealRealizations,
	listDealStages,
	submitRealization,
} from '../erp/operations.js';
import { parseTransferItem } from '../transfers/model.js';
import { recordRealizationEvent } from '../operation-log/realization-events.js';
import { ReservationService } from '../reservations/sql-service.js';
import {validateFreeStock} from './api-stock-availability.js';
import { stockAccess } from './api-stock-access.js';
import { assertDealRealizationQuantityAvailable } from './deal-realization-quantity.js';

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
	// action='delete-draft': удаляем только непроведённые реализации этой сделки;
	// action='draft': по каждому складу-группе создаём черновик Delivery Note (b24_deal_id, реальный склад);
	// action='submit': проводим переданные черновики (docstatus 1) → остаток ядра реально списывается.
	// Один документ на склад (группировка на фронте). «День X» (синк перестаёт затирать) — отдельно.
	app.post('/api/deal/realize-core', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; action?: unknown; groups?: unknown; names?: unknown; note?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const action = String(b.action ?? '');
		if (action === 'return') {
			return reply.code(403).send({ ok: false, error: 'прямой возврат запрещён — отправьте заявку Владимиру Дранишникову' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		const logDealId = Number(b.dealId);
		const loggedDocuments: string[] = [];
		try {
			const reservationService = app.reservationRuntime?.canWrite ? new ReservationService(app.reservationRuntime) : null;
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
				const validLineSegments = new Set(dealPlan.flatMap((item) => item.lineKey
					? [`${item.productId}\u0000line:${item.lineKey}`]
					: []));
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
				assertDealRealizationQuantityAvailable(
					dealPlan,
					dealStages,
					await listDealRealizations(erp, dealId),
					parsedGroups.flatMap((group) => group.lines),
				);
				for (const group of parsedGroups) for (const line of group.lines) {
					if (!line.isService && !group.storeTitle) throw new Error(`для товара #${line.productId} не выбран склад реализации`);
					if (line.segmentId !== 'base'
						&& !validStageSegments.has(`${line.productId}\u0000${line.segmentId}`)
						&& !validLineSegments.has(`${line.productId}\u0000${line.segmentId}`)) {
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
				const stocks = await fetchErpStocksFor(erp, productIds);
				for (const group of parsedGroups) for (const line of group.lines) {
					if (line.isService) continue;
					const available = Math.max(Number(stocks.get(line.productId)?.[group.storeTitle] ?? 0) - (reserved.get(`${line.productId}:${group.storeTitle}`) ?? 0), 0);
					if (line.qty > available + 0.000001) throw new Error(`на складе «${group.storeTitle}» для товара #${line.productId} свободно ${available}, к реализации выбрано ${line.qty}`);
				}
				await validateFreeStock(client,erp,parsedGroups.flatMap(group=>group.lines.filter(line=>!line.isService).map(line=>({productId:line.productId,qty:line.qty,fromStore:group.storeTitle}))), [], app.reservationRuntime, dealId);
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
			if (action === 'delete-draft') {
				const dealId = Number(b.dealId);
				if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
				const names = [...new Set((Array.isArray(b.names) ? b.names : []).map(String).map((name) => name.trim()).filter(Boolean))];
				if (!names.length) return reply.code(400).send({ ok: false, error: 'нет черновиков для удаления' });
				await client.call('crm.deal.get', { id: dealId });
				const dealDocuments = await listDealRealizations(erp, dealId);
				const allowedDrafts = new Set(dealDocuments.filter((document) => !document.submitted && !document.isReturn).map((document) => document.name));
				if (names.some((name) => !allowedDrafts.has(name))) throw new Error('один из документов не принадлежит этой сделке, является возвратом или уже проведён');
				for (const name of names) {
					const document = await erp.get<Record<string, unknown>>('Delivery Note', name);
					if (!document || String(document[DEAL_FIELD] ?? '') !== String(dealId)
						|| Number(document['is_return'] ?? 0) !== 0 || Number(document['docstatus'] ?? 0) !== 0) {
						throw new Error(`черновик ${name} изменился; обнови сделку и повтори действие`);
					}
				}
				for (const name of names) {
					await deleteRealizationDraft(erp, dealId, name);
					loggedDocuments.push(name);
				}
				await syncDealTechnicalFields(client, erp, dealId).catch((error: unknown) =>
					app.log.warn({ dealId, error }, 'Deleted realization drafts; deal sync failed'));
				await recordRealizationEvent(app, req, { operation: 'delete_draft', dealId, documents: loggedDocuments });
				return { ok: true, deleted: names };
			}
			if (action === 'cancel') {
				const dealId = Number(b.dealId);
				const name = String(b.names && Array.isArray(b.names) ? b.names[0] ?? '' : '').trim();
				if (!Number.isInteger(dealId) || dealId <= 0 || !name || (Array.isArray(b.names) && b.names.length !== 1)) {
					return reply.code(400).send({ ok: false, error: 'укажите одну реализацию и номер сделки' });
				}
				const access = await stockAccess(client);
				if (!appPermission(req, 'stock.edit_submitted', access.canManage)) {
					return reply.code(403).send({ ok: false, error: 'отменить проведённую реализацию может только снабжение или складской руководитель' });
				}
				const document = await erp.get<Record<string, unknown>>('Delivery Note', name);
				if (!document || String(document[DEAL_FIELD] ?? '') !== String(dealId)
					|| Number(document['is_return'] ?? 0) !== 0 || Number(document['docstatus'] ?? 0) !== 1) {
					throw new Error(`реализация ${name} изменилась или не принадлежит сделке; обнови страницу`);
				}
				if (!(Array.isArray(document['items']) && document['items'].some((item) =>
					dealProductIdFromCoreItemCode((item as Record<string, unknown>)['item_code']) !== null))) {
					throw new Error('этот документ не является товарной реализацией сделки');
				}
				const linkedReturns = await erp.list('Delivery Note', ['name'], [['return_against', '=', name], ['docstatus', '!=', 2]], 1);
				if (linkedReturns.length) throw new Error('у реализации есть возврат; сначала разберите связанный документ');
				if (app.reservationRuntime?.enabled) {
					const consumed = await app.reservationRuntime.query(async (connection) => connection.query<Array<{ count: number }>>(`
						SELECT COUNT(*) AS count FROM stock_reservation_events e
						JOIN stock_reservation_commands c ON c.id = e.command_id
						WHERE c.idempotency_key = ? AND e.event_type = 'consumed'
					`, [`consume:Delivery Note:${name}`]));
					if (Number(consumed[0]?.count ?? 0) > 0) throw new Error('по реализации списан резерв; для отмены нужна сверка резерва снабжением');
				}
				await erp.cancel('Delivery Note', name);
				loggedDocuments.push(name);
				await recordRealizationEvent(app, req, { operation: 'cancel', dealId, documents: loggedDocuments, actor: access.actor });
				const technicalClient = app.config?.autozadachiWebhook
					? new B24Client({ auth: { kind: 'webhook', url: app.config.autozadachiWebhook } })
					: client;
				await syncDealTechnicalFields(technicalClient, erp, dealId);
				return { ok: true, canceled: name };
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
				const me = reservationService
					? await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {})
					: null;
				for (const name of names) {
					await submitRealization(erp, name);
					submitted.push(name);
					loggedDocuments.push(name);
					const document = dealDocuments.find((candidate) => candidate.name === name);
					if (reservationService && me && document) {
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
			if ((action === 'draft' || action === 'delete-draft' || action === 'submit' || action === 'cancel' || action === 'return') && Number.isInteger(logDealId) && logDealId > 0) {
				await recordRealizationEvent(app, req, { operation: action === 'delete-draft' ? 'delete_draft' : action, dealId: logDealId, documents: loggedDocuments, error });
			}
			return reply.code(200).send({ ok: false, error });
		}
	});
}
