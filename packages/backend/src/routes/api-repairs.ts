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
import { type RepairData } from './repair-record.js';
import { currentUser } from './repair-user-access.js';
import { registerRepairDeleteRoute } from './repair-delete-route.js';
import { registerRepairIssueStoreRoute } from './repair-issue-store-route.js';
import { registerRepairInternalCommentRoute } from './repair-internal-comment-route.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import { registerRepairDealSyncRoute } from './repair-deal-sync-route.js';
import { movePresaleForStatus, moveRepairForStatus, writeOffRepairOnIssue } from './repair-stock-service.js';
import { registerRepairPaymentRoute } from './repair-payment-route.js';
import { registerRepairPriceApprovalRoute } from './repair-price-approval-route.js';
import { registerRepairListRoute } from './repair-list-route.js';
import { registerRepairCreateRoute } from './repair-create-route.js';
import { registerRepairPresaleCreateRoute } from './repair-presale-create-route.js';
import { registerRepairUpdateRoute } from './repair-update-route.js';

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

	registerRepairCreateRoute(app, clientFrom, systemClient, attachRepairLinkToCreatedDeal);

	registerRepairStoreStockRoute(app, clientFrom);

	registerRepairPresaleCreateRoute(app, clientFrom);

	registerRepairUpdateRoute(app, clientFrom, systemClient, attachRepairLinkToCreatedDeal);

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
