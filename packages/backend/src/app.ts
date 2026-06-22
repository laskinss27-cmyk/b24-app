import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import { registerHealthRoute } from './routes/health.js';
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
import { registerAppHandlerRoute } from './routes/app-handler.js';
import { registerMobileRoute } from './routes/mobile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dist-папка фронта относительно собранного бэка.
// Из dist/app.js путь до packages/frontend/dist:
//   tsx-режим (src/app.ts):    ../../frontend/dist
//   prod-режим (dist/app.js):  ../../frontend/dist (та же логика — symmetric layout)
const FRONTEND_DIST = resolve(__dirname, '..', '..', 'frontend', 'dist');

export interface AppOptions {
	config: Config;
}

export async function buildApp({ config }: AppOptions): Promise<FastifyInstance> {
	const app = Fastify({
		// Фото ремонтов едут data-URL'ами в JSON (превью ужимается на клиенте), поэтому поднимаем
		// лимит тела с дефолтных 1МБ. Документы (Word/Excel/PDF) грузятся на Диск Б24 ссылкой
		// (scope disk выдан приложению 2026-06-17), в JSON только ссылка — тело не раздувают.
		bodyLimit: 12 * 1024 * 1024,
		logger: {
			level: config.nodeEnv === 'production' ? 'info' : 'debug',
			// Подстраховка: даже если что-то залогируем вместе с телом запроса —
			// OAuth-токены не утекут в логи Y.Cloud.
			redact: {
				paths: [
					'AUTH_ID', 'REFRESH_ID', 'APPLICATION_TOKEN', 'access_token', 'refresh_token', 'client_secret',
					'*.AUTH_ID', '*.REFRESH_ID', '*.APPLICATION_TOKEN', '*.access_token', '*.refresh_token', '*.client_secret',
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
	app.decorate('frontendDist', FRONTEND_DIST);
	app.decorate('readFrontendIndex', async () => {
		if (!existsSync(FRONTEND_DIST)) return null;
		return readFile(join(FRONTEND_DIST, 'index.html'), 'utf-8');
	});

	registerHealthRoute(app);
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
	registerApiTransfersRoute(app);
	registerApiStockRoute(app);
	registerPlacementStockRoute(app);
	registerAppHandlerRoute(app);
	registerMobileRoute(app);

	return app;
}

declare module 'fastify' {
	interface FastifyInstance {
		config: Config;
		frontendDist: string;
		readFrontendIndex: () => Promise<string | null>;
	}
}
