import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ReservationService } from './service.js';
import { ReservationStore } from './store.js';

const SCAN_INTERVAL_MS = 5 * 60_000;

export function registerReservationService(app: FastifyInstance): void {
	const stateDirectory = process.env['B24_STATE_DIR'] ?? '/app/state';
	const service = new ReservationService(app, new ReservationStore(join(stateDirectory, 'reservations', 'state.json')));
	app.decorate('reservations', service);
	if (!app.config.devWebhook || app.config.nodeEnv === 'test') return;

	const client = new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } });
	const tick = (): void => {
		void service.refresh(client, true).catch((error) => app.log.error({ error: String(error) }, '[reservations] background scan failed'));
	};
	const initial = setTimeout(tick, 10_000);
	const interval = setInterval(tick, SCAN_INTERVAL_MS);
	initial.unref();
	interval.unref();
	app.addHook('onClose', async () => {
		clearTimeout(initial);
		clearInterval(interval);
	});
}

declare module 'fastify' {
	interface FastifyInstance {
		reservations: ReservationService;
	}
}
