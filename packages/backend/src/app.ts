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
import { registerAppHandlerRoute } from './routes/app-handler.js';
import { registerAdminBindRoute } from './routes/admin-bind.js';

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
		logger: {
			level: config.nodeEnv === 'production' ? 'info' : 'debug',
		},
	});

	app.register(formbody);

	// TEMP: глобальный логгер каждого запроса — увидим что реально шлёт Б24, на любой URL.
	// Снести когда разберёмся с install/oauth flow.
	app.addHook('onRequest', async (req) => {
		app.log.info({
			method: req.method,
			url: req.url,
			contentType: req.headers['content-type'],
			userAgent: req.headers['user-agent'],
			query: req.query,
		}, '[REQ] incoming');
	});
	app.addHook('preHandler', async (req) => {
		if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
			app.log.info({
				method: req.method,
				url: req.url,
				body: req.body,
			}, '[REQ] body');
		}
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
	registerAppHandlerRoute(app);
	registerAdminBindRoute(app);

	return app;
}

declare module 'fastify' {
	interface FastifyInstance {
		config: Config;
		frontendDist: string;
		readFrontendIndex: () => Promise<string | null>;
	}
}
