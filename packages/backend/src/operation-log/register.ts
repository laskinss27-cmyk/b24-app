import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { registerApiOperationLogRoute } from '../routes/api-operation-log.js';
import { OperationLogService } from './service.js';
import { OperationLogStore } from './store.js';

export function registerOperationLog(app: FastifyInstance): void {
	const stateDirectory = process.env['B24_STATE_DIR'] ?? '/app/state';
	const store = new OperationLogStore({ filePath: join(stateDirectory, 'operation-log', 'events.jsonl') });
	const service = new OperationLogService(store, (message) => app.log.warn(message));
	app.decorate('operationLog', service);
	registerApiOperationLogRoute(app);
}

declare module 'fastify' {
	interface FastifyInstance {
		operationLog: OperationLogService;
	}
}
