import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = await buildApp({ config });

try {
	const address = await app.listen({ port: config.port, host: config.host });
	app.log.info({ address, portalDomain: config.portalDomain }, 'b24-app backend listening');
} catch (err) {
	app.log.error(err);
	process.exit(1);
}

// Graceful shutdown — Y.Cloud Containers шлёт SIGTERM при scale-down
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, async () => {
		app.log.info({ signal }, 'shutting down');
		await app.close();
		process.exit(0);
	});
}
