import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { registerTransferCancelRoute } from './transfer-cancel-route.js';
import { registerTransferCollectRoute } from './transfer-collect-route.js';
import { registerTransferCreateRoutes } from './transfer-create-routes.js';
import { registerTransferDeleteRoute } from './transfer-delete-route.js';
import { registerTransferEditRoutes } from './transfer-edit-routes.js';
import { registerTransferListRoute } from './transfer-list-route.js';
import { registerTransferPostRoute } from './transfer-post-route.js';
import { registerTransferShipRoute } from './transfer-ship-route.js';
import { registerTransferShortageRoute } from './transfer-shortage-route.js';
import { createTransferDraftService } from './transfer-draft-service.js';
import { createTransferNotificationService } from './transfer-notification-service.js';
import { registerTransferRequestCreateRoutes } from './transfer-request-create-routes.js';
import { registerTransferRequestManagementRoutes } from './transfer-request-management-routes.js';
import { registerTransferReceiveRoute } from './transfer-receive-route.js';

/**
 * API модуля «Перемещения» (складской учёт). Документ перемещения — в нашем entity-store
 * ctv_transfers (JSON в DETAIL_TEXT), движение остатков — проводки в ядре через ErpClient.
 * Честный транзит: «Отгрузил» (А→Goods In Transit) и «Получил» (транзит→Б) — две проводки.
 * Статусы двигает ЗАКУПКА; менеджеры точек общаются в задаче Б24. См. спеку project_stock_transfer.
 *
 *  - /api/transfers/create   — менеджер сделки: создать перемещение(я) из сделки → черновик «Запрошено» + задача
 *  - /api/transfers/list     — список (по сделке для вкладки, без сделки — для окна закупки)
 *  - /api/transfers/ship     — закупка: «В пути» (проводка А→транзит)
 *  - /api/transfers/receive  — закупка: «Получено» (проводка транзит→Б)
 *
 * Токен — самого юзера (права Б24 соблюдаются). Домен — allowlist портала.
 */
interface AuthBody { domain?: string; accessToken?: string }

export function registerApiTransfersRoute(app: FastifyInstance): void {
	const operationLocks = new Set<string>();
	const notifications = createTransferNotificationService(app);
	const createDraftTransfer = createTransferDraftService(app, notifications);
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	registerTransferRequestCreateRoutes(app, clientFrom);
	registerTransferRequestManagementRoutes(app, clientFrom, operationLocks, createDraftTransfer);
	registerTransferCreateRoutes(app, clientFrom, notifications, createDraftTransfer);
	registerTransferListRoute(app, clientFrom);
	registerTransferEditRoutes(app, clientFrom);
	registerTransferCollectRoute(app, clientFrom, notifications);
	registerTransferShipRoute(app, clientFrom, operationLocks, notifications);
	registerTransferReceiveRoute(app, clientFrom, notifications);
	registerTransferPostRoute(app, clientFrom, operationLocks);
	registerTransferShortageRoute(app, clientFrom);
	registerTransferCancelRoute(app, clientFrom);
	registerTransferDeleteRoute(app, clientFrom, operationLocks);
}
