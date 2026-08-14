import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { registerRepairFileRoutes } from './repair-file-routes.js';
import { registerRepairContactSearchRoutes } from './repair-contact-search-routes.js';
import { registerRepairStoreStockRoute } from './repair-store-stock-route.js';
import { type RepairData } from './repair-record.js';
import { registerRepairDeleteRoute } from './repair-delete-route.js';
import { registerRepairIssueStoreRoute } from './repair-issue-store-route.js';
import { registerRepairInternalCommentRoute } from './repair-internal-comment-route.js';
import { type DealSyncResult } from './repair-deal-sync-service.js';
import { registerRepairDealSyncRoute } from './repair-deal-sync-route.js';
import { registerRepairPaymentRoute } from './repair-payment-route.js';
import { registerRepairPriceApprovalRoute } from './repair-price-approval-route.js';
import { registerRepairListRoute } from './repair-list-route.js';
import { registerRepairCreateRoute } from './repair-create-route.js';
import { registerRepairPresaleCreateRoute } from './repair-presale-create-route.js';
import { registerRepairUpdateRoute } from './repair-update-route.js';
import { registerRepairStatusUpdateRoute } from './repair-status-update-route.js';
import { registerRepairClientRefusalRoute } from './repair-client-refusal-route.js';
import { addRepairLinkToDealTimeline, buildRepairDeepLink } from '../repair-deal-link.js';

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
	const repairLink = (id: number, repairNo: number): string => buildRepairDeepLink({
		portalDomain: app.config.portalDomain,
		appClientId: app.config.appClientId,
		configuredBase: process.env['REPAIRS_SECTION_URL'],
		repairId: id,
		repairNo,
	});
	const attachRepairLinkToCreatedDeal = async (
		client: B24Client,
		data: RepairData,
		repairId: number,
		dealSync: DealSyncResult,
	): Promise<void> => {
		if (!dealSync.created || !dealSync.dealId) return;
		try {
			await addRepairLinkToDealTimeline(client, dealSync.dealId, repairLink(repairId, data.repairNo));
			app.log.info(
				{ repairId, dealId: dealSync.dealId },
				'[api/repairs] ссылка на ремонт добавлена в ленту сделки',
			);
		} catch (error) {
			// Ссылка полезна, но её временная ошибка не должна отменять уже созданные ремонт и сделку.
			app.log.warn(
				{ repairId, dealId: dealSync.dealId },
				`[api/repairs] не удалось добавить ссылку в ленту сделки — ${errInfo(error)}`,
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

	registerRepairStatusUpdateRoute(app, clientFrom, systemClient, attachRepairLinkToCreatedDeal);

	registerRepairClientRefusalRoute(app, clientFrom, systemClient);

	registerRepairIssueStoreRoute(app, clientFrom);

	registerRepairContactSearchRoutes(app, clientFrom);

	registerRepairFileRoutes(app, clientFrom, systemClient);
}
