import type { FastifyInstance } from 'fastify';
import type { DatabaseRuntime } from '../database/runtime.js';
import { registerSupplyOrdersRoute } from './api-supply-orders-route.js';
import { registerSupplyRequestRoutes } from './api-supply-request-routes.js';
import { registerSupplyDocumentCreationRoute } from './api-supply-document-creation-route.js';
import { registerSupplySupplierRoutes } from './api-supply-supplier-routes.js';
import { registerSupplyPurchaseRoutes } from './api-supply-purchase-routes.js';
import { registerSupplyPurchaseTransferRoute } from './api-supply-purchase-transfer-route.js';

/**
 * API рабочего места «Снаб». Источник спроса — ЗАЯВКИ (Material Request) ядра по сделкам:
 * менеджер из сделки осознанно отправляет нехватку в снабжение (кнопка «Снабжение»).
 *  - /api/supply/orders  — все заявки из ядра (позиции + комментарии + остатки) + название сделки из Б24.
 *  - /api/supply/request — создать заявку по выбранным товарам сделки.
 * Канарейку режет фронт. Токен юзера, домен — allowlist портала.
 */
const supplyCreationLocks = new Set<string>();

export function registerApiSupplyRoute(app: FastifyInstance, database?: DatabaseRuntime): void {
	registerSupplyOrdersRoute(app, database);
	registerSupplyRequestRoutes(app, supplyCreationLocks);
	registerSupplyDocumentCreationRoute(app, supplyCreationLocks);
	registerSupplySupplierRoutes(app);
	registerSupplyPurchaseRoutes(app);
	registerSupplyPurchaseTransferRoute(app, supplyCreationLocks);
}
