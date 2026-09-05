import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { DatabaseRuntime } from './database/runtime.js';
import { registerHealthRoute, registerReadinessRoute } from './routes/health.js';
import { registerInstallRoute } from './routes/install.js';
import { registerUninstallRoute } from './routes/uninstall.js';
import { registerPlacementDealTabRoute } from './routes/placement-deal-tab.js';
import { registerPlacementTaskInventoryRoute } from './routes/placement-task-inventory.js';
import { registerPlacementInventoryRoute } from './routes/placement-inventory.js';
import { registerPlacementCatalogRoute } from './routes/placement-catalog.js';
import { registerApiInventoryRoute } from './routes/api-inventory.js';
import { registerApiCatalogRoute } from './routes/api-catalog.js';
import { registerApiQuicksaleRoute } from './routes/api-quicksale.js';
import { registerApiReportsRoute } from './routes/api-reports.js';
import { registerApiRealizationsRoute } from './routes/api-realizations.js';
import { registerApiDealRoute } from './routes/api-deal.js';
import { registerPlacementSalesReportRoute } from './routes/placement-sales-report.js';
import { registerPlacementRepairsRoute } from './routes/placement-repairs.js';
import { registerApiRepairsRoute } from './routes/api-repairs.js';
import { registerApiTransfersRoute } from './routes/api-transfers.js';
import { registerApiStockRoute } from './routes/api-stock.js';
import { registerPlacementStockRoute } from './routes/placement-stock.js';
import { registerPlacementSupplyRoute } from './routes/placement-supply.js';
import { registerApiSupplyRoute } from './routes/api-supply.js';
import { registerApiMarketplacesRoute } from './routes/api-marketplaces.js';
import { registerApiContractsRoute } from './routes/api-contracts.js';
import { registerApiAccessControlRoute } from './routes/api-access-control.js';
import { registerApiReportBuilderRoute } from './routes/api-report-builder.js';
import { registerPlacementReportBuilderRoute } from './routes/placement-report-builder.js';
import { registerAccessPolicyHook } from './access-policy-hook.js';
import { registerAppHandlerRoute } from './routes/app-handler.js';
import { registerMobileRoute } from './routes/mobile.js';
import { registerOperationLog } from './operation-log/register.js';
import { registerApiAdminRepairDiagnosticsRoute } from './routes/api-admin-repair-diagnostics.js';
import { registerApiAdminDealDocumentsRoute } from './routes/api-admin-deal-documents.js';
import { registerApiAdminDealFulfillmentRoute } from './routes/api-admin-deal-fulfillment.js';
import { registerApiAdminControlRoute } from './routes/api-admin-control.js';
import { registerApiAdminSupplyBackfillRoute } from './routes/api-admin-supply-backfill.js';
import { registerApiAdminSupplyShadowRoute } from './routes/api-admin-supply-shadow.js';
import { registerMobileSessionAuthHook } from './mobile-auth-hook.js';
import { createOwnerOAuthVault, type OwnerOAuthVault } from './b24/owner-oauth-vault.js';
import type { ReservationRuntime } from './reservations/runtime.js';
import { registerApiReservationsRoute } from './routes/api-reservations.js';
import type { TransferSqlWriteRuntime } from './transfers/sql-runtime.js';
import type { TransferRequestSqlWriteRuntime } from './transfers/request-sql-runtime.js';
import type { InventorySqlWriteRuntime } from './inventory-sql/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dist-папка фронта относительно собранного бэка.
// Из dist/app.js путь до packages/frontend/dist:
//   tsx-режим (src/app.ts):    ../../frontend/dist
//   prod-режим (dist/app.js):  ../../frontend/dist (та же логика — symmetric layout)
const FRONTEND_DIST = resolve(__dirname, '..', '..', 'frontend', 'dist');

export interface AppOptions {
	config: Config;
	database?: DatabaseRuntime;
	reservations?: ReservationRuntime;
	transferSqlWriter?: TransferSqlWriteRuntime;
	transferRequestSqlWriter?: TransferRequestSqlWriteRuntime;
	inventorySqlWriter?: InventorySqlWriteRuntime;
	ownerOAuthVault?: OwnerOAuthVault | null;
}

export async function buildApp({ config, database, reservations, transferSqlWriter, transferRequestSqlWriter, inventorySqlWriter, ownerOAuthVault = createOwnerOAuthVault(config) }: AppOptions): Promise<FastifyInstance> {
	const app = Fastify({
		// Фото ремонтов едут data-URL'ами в JSON (превью ужимается на клиенте), поэтому поднимаем
		// лимит тела с дефолтных 1МБ. Документы (Word/Excel/PDF) грузятся на Диск Б24 ссылкой
		// (scope disk выдан приложению 2026-06-17), в JSON только ссылка — тело не раздувают.
		bodyLimit: 12 * 1024 * 1024,
		logger: {
			level: config.nodeEnv === 'production' ? 'info' : 'debug',
			// Подстраховка: даже если что-то залогируем вместе с телом запроса —
			// OAuth-токены не утекут в рабочие логи.
			redact: {
				paths: [
					'AUTH_ID', 'REFRESH_ID', 'APPLICATION_TOKEN', 'access_token', 'refresh_token', 'accessToken', 'refreshToken', 'client_secret', 'authorization', 'appOperatorToken',
					'*.AUTH_ID', '*.REFRESH_ID', '*.APPLICATION_TOKEN', '*.access_token', '*.refresh_token', '*.accessToken', '*.refreshToken', '*.client_secret', '*.authorization', '*.appOperatorToken',
				],
				censor: '[REDACTED]',
			},
		},
	});

	app.register(formbody);

	// Security-заголовки на все ответы.
	// frame-ancestors: нас встраивает только портал Б24 (iframe карточки сделки),
	// поэтому фреймить нас могут лишь *.bitrix24.ru — защита от clickjacking.
	// script-src НЕ задаём — иначе сломаем инлайн __B24_CONTEXT__ и SDK с api.bitrix24.com.
	app.addHook('onRequest', async (_req, reply) => {
		reply.header('X-Content-Type-Options', 'nosniff');
		reply.header('Referrer-Policy', 'no-referrer');
		reply.header('Content-Security-Policy', "frame-ancestors 'self' https://*.bitrix24.ru");
	});

	// Статика фронта. Если dist ещё нет — пропускаем (на dev фронт через Vite на :5173)
	if (existsSync(FRONTEND_DIST)) {
		await app.register(fastifyStatic, {
			root: FRONTEND_DIST,
			prefix: '/',
			// index.html обслуживаем не автоматически — она нужна только как шаблон
			// для placement-роута (туда инжектим __B24_CONTEXT__).
			index: false,
		});
	} else {
		app.log.warn({ FRONTEND_DIST }, 'frontend dist не найден — статика отключена (нормально в dev)');
	}

	app.decorate('config', config);
	app.decorate('databaseRuntime', database ?? null);
	app.decorate('reservationRuntime', reservations ?? null);
	app.decorate('transferSqlWriter', transferSqlWriter ?? null);
	app.decorate('transferRequestSqlWriter', transferRequestSqlWriter ?? null);
	app.decorate('inventorySqlWriter', inventorySqlWriter ?? null);
	app.decorate('ownerOAuthVault', ownerOAuthVault);
	app.decorate('frontendDist', FRONTEND_DIST);
	app.decorate('readFrontendIndex', async () => {
		if (!existsSync(FRONTEND_DIST)) return null;
		return readFile(join(FRONTEND_DIST, 'index.html'), 'utf-8');
	});

	// Новые правила доступа включаются по сотрудникам и отделам. Для ещё не
	// настроенных записей хук оставляет прежние ролевые проверки без изменений.
	registerMobileSessionAuthHook(app);
	registerAccessPolicyHook(app);
	registerOperationLog(app);

	registerHealthRoute(app);
	registerReadinessRoute(app, database, reservations, transferSqlWriter?.enabled ? transferSqlWriter : undefined, transferRequestSqlWriter?.enabled ? transferRequestSqlWriter : undefined, inventorySqlWriter?.enabled ? inventorySqlWriter : undefined);
	if (database) app.addHook('onClose', async () => database.close());
	if (reservations) app.addHook('onClose', async () => reservations.close());
	if (transferSqlWriter) app.addHook('onClose', async () => transferSqlWriter.close());
	if (transferRequestSqlWriter) app.addHook('onClose', async () => transferRequestSqlWriter.close());
	if (inventorySqlWriter) app.addHook('onClose', async () => inventorySqlWriter.close());
	registerInstallRoute(app);
	registerUninstallRoute(app);
	registerPlacementDealTabRoute(app);
	registerPlacementTaskInventoryRoute(app);
	registerPlacementInventoryRoute(app);
	registerPlacementCatalogRoute(app);
	registerApiInventoryRoute(app);
	registerApiCatalogRoute(app);
	registerApiQuicksaleRoute(app);
	registerApiReportsRoute(app);
	registerApiRealizationsRoute(app);
	registerApiDealRoute(app);
	registerPlacementSalesReportRoute(app);
	registerPlacementRepairsRoute(app);
	registerApiRepairsRoute(app);
	registerApiAdminRepairDiagnosticsRoute(app);
	registerApiAdminDealDocumentsRoute(app);
	registerApiAdminDealFulfillmentRoute(app);
	registerApiAdminControlRoute(app);
	registerApiAdminSupplyBackfillRoute(app);
	registerApiAdminSupplyShadowRoute(app, database);
	registerApiTransfersRoute(app);
	registerApiStockRoute(app);
	registerPlacementStockRoute(app);
	registerPlacementSupplyRoute(app);
	registerApiSupplyRoute(app, database);
	registerApiReservationsRoute(app, reservations);
	registerApiMarketplacesRoute(app);
	registerApiContractsRoute(app);
	registerApiAccessControlRoute(app);
	registerApiReportBuilderRoute(app);
	registerPlacementReportBuilderRoute(app);
	registerAppHandlerRoute(app);
	registerMobileRoute(app);

	return app;
}

declare module 'fastify' {
	interface FastifyInstance {
		config: Config;
		databaseRuntime: DatabaseRuntime | null;
		ownerOAuthVault: OwnerOAuthVault | null;
		reservationRuntime: ReservationRuntime | null;
		transferSqlWriter: TransferSqlWriteRuntime | null;
		transferRequestSqlWriter: TransferRequestSqlWriteRuntime | null;
		inventorySqlWriter: InventorySqlWriteRuntime | null;
		frontendDist: string;
		readFrontendIndex: () => Promise<string | null>;
	}
}
