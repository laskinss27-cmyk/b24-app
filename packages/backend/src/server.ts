import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadDatabaseConfig } from './database/config.js';
import { createDatabaseRuntime } from './database/runtime.js';
import { loadReservationConfig } from './reservations/config.js';
import { createReservationRuntime } from './reservations/runtime.js';

const config = loadConfig();
const database = createDatabaseRuntime(loadDatabaseConfig());
const reservations = createReservationRuntime(loadReservationConfig());

const app = await buildApp({ config, database, reservations });

try {
	const address = await app.listen({ port: config.port, host: config.host });
	app.log.info({ address, portalDomain: config.portalDomain }, 'b24-app backend listening');
} catch (err) {
	app.log.error(err);
	process.exit(1);
}

// Корректно завершаем запросы при остановке или замене Docker-контейнера.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, async () => {
		app.log.info({ signal }, 'shutting down');
		await app.close();
		process.exit(0);
	});
}
