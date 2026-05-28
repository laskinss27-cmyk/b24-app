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

	return app;
}

declare module 'fastify' {
	interface FastifyInstance {
		config: Config;
		frontendDist: string;
		readFrontendIndex: () => Promise<string | null>;
	}
}
