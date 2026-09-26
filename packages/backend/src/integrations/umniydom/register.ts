import type { FastifyInstance } from 'fastify';
import type { OrdersConfig } from './config.js';
import { OrdersStore } from './store.js';
import { registerOrdersRoute } from './route.js';
import { BitrixOrderStatusCrm } from './order-status-crm.js';
import { registerOrderStatusRoute } from './order-status-route.js';
import { webhookCall } from './crm.js';
import { PlannerInbox } from './planner/store.js';
import { registerPlannerRoute } from './planner/route.js';

export async function registerOrdersIntegration(app: FastifyInstance, config: OrdersConfig): Promise<void> {
	const store = new OrdersStore(config.database, config.mode, config.sourceId, config.statusMode !== 'off');
	app.addHook('onClose', async () => store.close());
	store.bindDestination(config.portalDomain, config.chatId);
	await registerOrdersRoute(app, config, store);
	if (process.env['UMNIYDOM_PLANNER_ENABLED'] === '1') await registerPlannerRoute(app, config, new PlannerInbox(store.db));
	if (config.statusMode !== 'off') await registerOrderStatusRoute(app, config, store, new BitrixOrderStatusCrm(webhookCall(config.webhook!)));
}
