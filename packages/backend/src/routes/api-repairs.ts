import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { appPermission } from '../access-policy.js';
import { registerRepairFileRoutes } from './repair-file-routes.js';
import { registerRepairContactSearchRoutes } from './repair-contact-search-routes.js';
import { registerRepairStoreStockRoute } from './repair-store-stock-route.js';
import {
	CLIENT_ORDER,
	PRESALE_ORDER,
	isLocked,
	normalizeStatus,
	statusOrder,
	type RepairKind,
	type RepairStatus,
} from './repair-status.js';
import { assignRepairNo } from './repair-storage.js';
import { type RepairData, type RepairFile, type RepairPhoto } from './repair-record.js';
import { currentUser } from './repair-user-access.js';
import { registerRepairDeleteRoute } from './repair-delete-route.js';
import { registerRepairIssueStoreRoute } from './repair-issue-store-route.js';
import { registerRepairInternalCommentRoute } from './repair-internal-comment-route.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import { registerRepairDealSyncRoute } from './repair-deal-sync-route.js';
import { resolveOrCreateContact } from './repair-contact-service.js';
import { movePresaleForStatus, moveRepairForStatus, syncRepairStock, writeOffRepairOnIssue } from './repair-stock-service.js';
import { registerRepairPaymentRoute } from './repair-payment-route.js';
import { registerRepairPriceApprovalRoute } from './repair-price-approval-route.js';
import { createRepairNotifyTask } from './repair-notification-service.js';
import { registerRepairListRoute } from './repair-list-route.js';

export type { RepairKind, RepairStatus } from './repair-status.js';

/**
 * API модуля «Ремонты» (RMA). Всё наше: карточки лежат в нашем entity-store ctv_repairs,
 * НЕ в нативной сущности Б24. От Б24 берём только клиента (поиск контакта) и Диск (фото).
 * Фронтовый BX24 виснет на entity.* → все операции с хранилищем тут, серверным B24Client.
 *
 *  - /api/repairs/list            — список ремонтов (+ идемпотентно создаёт хранилище)
 *  - /api/repairs/create          — принять в ремонт (новая карточка, статус «Принято»)
 *  - /api/repairs/update-status   — сменить статус (Принято→Отправлено→Вернулось→Выдано)
 *  - /api/repairs/search-contacts — поиск контакта Б24 по ФИО (для поля «Клиент»)
 *  - /api/repairs/upload-photo    — загрузка фото на Б24 Диск (возвращает ссылку)
 *
 * Токен — самого юзера (права Б24 соблюдаются). Домен — allowlist портала.
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}





export function registerApiRepairsRoute(app: FastifyInstance): void {
	const systemClient = (): B24Client | null => app.config.devWebhook
		? new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } })
		: null;
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};
	const repairLink = (id: number, repairNo: number): string => {
		const configuredBase = String(process.env['REPAIRS_SECTION_URL'] ?? '').trim();
		const appCode = String(app.config.appClientId ?? '').trim();
		const base = configuredBase
			|| (appCode
				? `https://${app.config.portalDomain}/marketplace/view/${encodeURIComponent(appCode)}/`
				: `https://${app.config.portalDomain}/devops/placement/568/`);
		const url = new URL(base);
		url.searchParams.set(base.includes('/marketplace/view/') ? 'params[repairId]' : 'repairId', String(id));
		return `[URL=${url.toString()}]Открыть ремонт #${repairNo || id}[/URL]`;
	};
	const attachRepairLinkToCreatedDeal = async (
		client: B24Client,
		data: RepairData,
		repairId: number,
		dealSync: DealSyncResult,
	): Promise<void> => {
		if (!dealSync.created || !dealSync.dealId) return;
		try {
			await client.call('crm.deal.update', {
				id: dealSync.dealId,
				fields: {
					COMMENTS: repairLink(repairId, data.repairNo),
				},
			});
			app.log.info(
				{ repairId, dealId: dealSync.dealId },
				'[api/repairs] ссылка на ремонт добавлена в комментарий сделки',
			);
		} catch (error) {
			// Ссылка полезна, но её временная ошибка не должна отменять уже созданные ремонт и сделку.
			app.log.warn(
				{ repairId, dealId: dealSync.dealId },
				`[api/repairs] не удалось добавить ссылку в комментарий сделки — ${errInfo(error)}`,
			);
		}
	};
	registerRepairListRoute(app, clientFrom);

	// Принять в ремонт — новая карточка (статус «Принято»).
	app.post('/api/repairs/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const s = (v: unknown): string => String(v ?? '').trim();
		const device = s(b['device']);
		const clientName = s((b['client'] as { name?: unknown } | undefined)?.name);
		const point = s(b['point']);
		// Клиент обязателен для любого ремонта (платный/гарантийный): на него вешаем сделку и подписываем позицию склада.
		if (!clientName) return reply.code(400).send({ ok: false, error: 'клиент обязателен — укажи ФИО или организацию' });
		if (!point) return reply.code(400).send({ ok: false, error: 'выбери склад приёмки — без него ремонт сохранить нельзя' });

		const photos: RepairPhoto[] = Array.isArray(b['photos'])
			? (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url)
			: [];
		const files: RepairFile[] = Array.isArray(b['files'])
			? (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url)
			: [];
		const payType: 'warranty' | 'paid' = b['payType'] === 'paid' ? 'paid' : 'warranty';
		const reqCost = payType === 'paid' && b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
		const reqOur = payType === 'paid' && b['ourPrice'] != null && b['ourPrice'] !== '' && Number.isFinite(Number(b['ourPrice'])) ? Number(b['ourPrice']) : null;
		try {
			const me = await currentUser(client);
			me.canEditPrice = appPermission(req, 'repairs.edit_prices', me.canEditPrice);
			const byId = me.id;
			const byName = me.name;
			const cost = me.canEditPrice ? reqCost : null; // цену проставит только тот, кому разрешено
			const ourPrice = me.canEditPrice ? reqOur : null;
			const now = new Date().toISOString();
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };
			// Клиент = контакт Б24: берём привязанный / находим по телефону / заводим нового (с телефоном).
			const contactId = await resolveOrCreateContact(client, { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) }, app.log);

			const repairNo = await assignRepairNo(client, app.log);

			const data: RepairData = {
				kind: 'client',
				status: 'received_tt',
				repairNo,
				client: { contactId, name: s(cl.name), phone: s(cl.phone) },
				device,
				model: s(b['model']),
				serial: s(b['serial']),
				point,
				appearance: s(b['appearance']),
				defect: s(b['defect']),
				payType,
				cost,
				ourPrice,
				dealId: null,
				taskId: null,
				repairItemCode: null,
				repairStore: null,
				issueStore: null,
				repairDeliveryNote: null,
				productId: null,
				sourceStore: null,
				// Комментарий СЦ заполняет/правит только снабжение+ (у менеджеров поле неактивно).
				comment: me.canEditPrice ? s(b['comment']) : '',
				internalComment: s(b['internalComment']),
				photos,
				files,
				createdAt: now,
				createdById: byId,
				createdByName: byName,
				history: [{ at: now, status: 'received_tt', byId, byName }],
			};
			// Сначала обязательно принимаем сам аппарат в ядре. Без складской карточки ремонт
			// не считаем принятым; сделку создаём только после успешного прихода.
			await syncRepairStock(data, app.log);
			const dealClient = systemClient() ?? client;
			const dealSync = await syncRepairDeal(dealClient, data, app.log);
			const nameParts = [device, data.model, data.client.name].filter(Boolean);
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: REPAIRS_ENTITY,
				NAME: nameParts.join(' · ') || 'Ремонт',
				DETAIL_TEXT: JSON.stringify(data),
			});
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			await attachRepairLinkToCreatedDeal(dealClient, data, id, dealSync);
			const taskSync = await createRepairNotifyTask(client, data, id, app.log);
			if (taskSync.taskId) {
				data.taskId = taskSync.taskId;
				await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: nameParts.join(' · ') || 'Ремонт', DETAIL_TEXT: JSON.stringify(data) });
			}
			app.log.info({ id }, '[api/repairs/create] ok');
			return {
				ok: true,
				id,
				repair: { id, name: nameParts.join(' · '), ...data },
				canEditPrice: me.canEditPrice,
				dealCreated: dealSync.created,
				dealNoContact: dealSync.noContact,
				syncWarning: dealSync.syncWarning,
				taskCreated: Boolean(taskSync.taskId),
				taskError: taskSync.error,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	registerRepairStoreStockRoute(app, clientFrom);

	// Принять в ПРЕДПРОДАЖНЫЙ ремонт: наш товар со склада-источника (productId из остатков) уходит в ремонт.
	// Без клиента/цен/сделки. Создаётся в статусе «принято в офисе» + перемещение источник→Измайловский.
	app.post('/api/repairs/create-presale', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { sourceStore?: unknown; productId?: unknown; itemName?: unknown; internalComment?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const s = (v: unknown): string => String(v ?? '').trim();
		const sourceStore = s(b['sourceStore']);
		const productId = Number(b['productId']);
		const itemName = s(b['itemName']);
		if (!sourceStore) return reply.code(400).send({ ok: false, error: 'не выбран склад-источник' });
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'не выбран аппарат' });
		try {
			const me = await currentUser(client);
			const now = new Date().toISOString();
			const repairNo = await assignRepairNo(client, app.log);
			const data: RepairData = {
				kind: 'presale',
				status: 'pre_office',
				repairNo,
				client: { contactId: null, name: '', phone: '' },
				device: itemName, model: '', serial: '', point: '',
				appearance: '', defect: '',
				payType: 'warranty', cost: null, ourPrice: null, dealId: null,
				taskId: null,
				repairItemCode: null,
				repairStore: sourceStore, // товар сейчас на источнике; первый статус сдвинет в офис
				issueStore: null,
				repairDeliveryNote: null,
				productId, sourceStore,
				comment: '',
				internalComment: s(b['internalComment']),
				photos: [], files: [],
				createdAt: now, createdById: me.id, createdByName: me.name,
				history: [{ at: now, status: 'pre_office', byId: me.id, byName: me.name }],
			};
			// «Принято в офисе» — перемещаем товар источник → Измайловский (мутирует repairStore).
			await movePresaleForStatus(data, 'pre_office', app.log);
			const name = (`[предпродажа] ${itemName}`).slice(0, 120) || 'Предпродажный ремонт';
			const added = await client.call<number | { id?: number }>('entity.item.add', { ENTITY: REPAIRS_ENTITY, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			const newId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!newId) throw new Error('entity.item.add не вернул id');
			const taskSync = await createRepairNotifyTask(client, data, newId, app.log);
			if (taskSync.taskId) {
				data.taskId = taskSync.taskId;
				await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: newId, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			}
			app.log.info({ id: newId, productId, sourceStore }, '[api/repairs/create-presale] ok');
			return { ok: true, id: newId, repair: { id: newId, name, ...data }, taskCreated: Boolean(taskSync.taskId), taskError: taskSync.error };
		} catch (err) {
			app.log.error({}, `[api/repairs/create-presale] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Редактировать ремонт (все поля карточки). Статус/историю/дату приёма/автора НЕ трогаем.
	app.post('/api/repairs/update', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b['id']);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const s = (v: unknown): string => String(v ?? '').trim();
		const point = s(b['point']);
		if (!point) return reply.code(400).send({ ok: false, error: 'выбери склад приёмки — без него ремонт сохранить нельзя' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const me = await currentUser(client);
			const canEditLocked = appPermission(req, 'repairs.edit', me.canEditPrice);
			me.canEditPrice = appPermission(req, 'repairs.edit_prices', me.canEditPrice);
			// Заморозка с «принято в офисе»: правит только снабжение+.
			if (isLocked(normalizeStatus(data.status)) && !canEditLocked) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — изменять может только снабжение' });
			}
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };
			const prevPay = data.payType ?? 'warranty';
			const prevCost = typeof data.cost === 'number' ? data.cost : null;
			const prevOur = typeof data.ourPrice === 'number' ? data.ourPrice : null;
			// Перезаписываем редактируемые поля, сохраняем status/history/createdAt/createdBy.
			const contactId = await resolveOrCreateContact(client, { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) }, app.log);
			data.client = { contactId, name: s(cl.name), phone: s(cl.phone) };
			data.device = s(b['device']);
			data.model = s(b['model']);
			data.serial = s(b['serial']);
			data.point = point;
			data.appearance = s(b['appearance']);
			data.defect = s(b['defect']);
			data.internalComment = s(b['internalComment']);
			data.payType = b['payType'] === 'paid' ? 'paid' : 'warranty';
			// Цены меняет только тот, кому разрешено; иначе оставляем прежние (warranty всё обнуляет).
			const reqCost = b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
			const reqOur = b['ourPrice'] != null && b['ourPrice'] !== '' && Number.isFinite(Number(b['ourPrice'])) ? Number(b['ourPrice']) : null;
			data.cost = data.payType !== 'paid' ? null : (me.canEditPrice ? reqCost : prevCost);
			data.ourPrice = data.payType !== 'paid' ? null : (me.canEditPrice ? reqOur : prevOur);
			// Комментарий СЦ правит только снабжение+; у менеджера держим прежний.
			data.comment = me.canEditPrice ? s(b['comment']) : (data.comment ?? '');
			// Лог: если изменился вид/цены — пишем кто и что.
			data.history = Array.isArray(data.history) ? data.history : [];
			if (prevPay !== data.payType || prevCost !== data.cost || prevOur !== data.ourPrice) {
				const parts: string[] = [];
				if (prevPay !== data.payType) parts.push(`вид: ${data.payType === 'paid' ? 'платный' : 'гарантийный'}`);
				if (prevCost !== data.cost) parts.push(`цена СЦ: ${data.cost == null ? '—' : `${data.cost}₽`}`);
				if (prevOur !== data.ourPrice) parts.push(`наша цена: ${data.ourPrice == null ? '—' : `${data.ourPrice}₽`}`);
				data.history.push({ at: new Date().toISOString(), status: data.status, byId: me.id, byName: me.name, note: parts.join(', ') });
			}
			// Сделку держим в актуальном (мутирует data.dealId); позицию склада переименовываем вслед за карточкой.
			const dealClient = systemClient() ?? client;
			const dealSync = await syncRepairDeal(dealClient, data, app.log);
			await attachRepairLinkToCreatedDeal(dealClient, data, id, dealSync);
			await syncRepairStock(data, app.log, { allowCreate: false });
			if (Array.isArray(b['photos'])) {
				data.photos = (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url);
			}
			if (Array.isArray(b['files'])) {
				data.files = (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url);
			}
			const name = [data.device, data.model, data.client.name].filter(Boolean).join(' · ') || 'Ремонт';
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id }, '[api/repairs/update] ok');
			return {
				ok: true,
				repair: { id, name, ...data },
				canEditPrice: me.canEditPrice,
				dealCreated: dealSync.created,
				dealNoContact: dealSync.noContact,
				syncWarning: dealSync.syncWarning,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	registerRepairInternalCommentRoute(app, clientFrom);

	registerRepairPaymentRoute(app, clientFrom, systemClient, attachRepairLinkToCreatedDeal);

	registerRepairPriceApprovalRoute(app, clientFrom, systemClient, repairLink, attachRepairLinkToCreatedDeal);

	registerRepairDealSyncRoute(app, clientFrom, systemClient, attachRepairLinkToCreatedDeal);

	registerRepairDeleteRoute(app, clientFrom);

	// Сменить статус ремонта (только вперёд/назад по нашей цепочке).
	app.post('/api/repairs/update-status', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; status?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		const status = String(b.status) as RepairStatus;
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		if (![...CLIENT_ORDER, ...PRESALE_ORDER].includes(status)) return reply.code(400).send({ ok: false, error: 'bad status' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const kind: RepairKind = data.kind === 'presale' ? 'presale' : 'client';
			if (!statusOrder(kind).includes(status)) return reply.code(400).send({ ok: false, error: 'статус не из цепочки этого ремонта' });
			const me = await currentUser(client);
			// Заморозка (только клиентский): с «принято в офисе» двигать статус может только снабжение+.
			// presale не замораживаем — isLocked для его статусов = false.
			if (isLocked(normalizeStatus(data.status, kind)) && !appPermission(req, 'repairs.change_status', me.canEditPrice)) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — статус двигает только снабжение' });
			}
			data.status = status;
			data.history = Array.isArray(data.history) ? data.history : [];
			data.history.push({ at: new Date().toISOString(), status, byId: me.id, byName: me.name });
			// Движение по новому статусу — своё для каждого потока (мутирует data.repairStore).
			if (kind === 'presale') {
				await movePresaleForStatus(data, status, app.log);
			} else {
				await moveRepairForStatus(data, status, app.log);
				// «Выдано» — списываем аппарат со склада (Delivery Note ядра, цена 0, привязка к сделке).
				if (status === 'issued') await writeOffRepairOnIssue(data, app.log);
			}
			const dealSync = kind === 'client'
				? await syncRepairDeal(systemClient() ?? client, data, app.log)
				: null;
			if (dealSync) {
				await attachRepairLinkToCreatedDeal(systemClient() ?? client, data, id, dealSync);
			}
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, status }, '[api/repairs/update-status] ok');
			return {
				ok: true,
				dealCreated: dealSync?.created ?? false,
				dealNoContact: dealSync?.noContact ?? false,
				syncWarning: dealSync?.syncWarning ?? null,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/update-status] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	registerRepairIssueStoreRoute(app, clientFrom);

	registerRepairContactSearchRoutes(app, clientFrom);

	registerRepairFileRoutes(app, clientFrom, systemClient);
}
