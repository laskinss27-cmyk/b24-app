import 'dotenv/config';
import Fastify from 'fastify';
import { loadOrdersConfig, receiverAddress } from './config.js';
import { registerOrdersRoute } from './route.js';
import { BitrixOrdersCrm, MockOrdersCrm, webhookCall } from './crm.js';
import { OrdersStore, type Customer } from './store.js';
import { processOne } from './worker.js';
import { BitrixOrderStatusCrm } from './order-status-crm.js';
import { registerOrderStatusRoute } from './order-status-route.js';

async function main(): Promise<void> {
	const config = loadOrdersConfig();
	if (!config) { console.log('Orders integration is off'); return; }
	const command = process.argv[2];
	if (!['serve', 'once', 'worker', 'list', 'resolve-customer', 'resolve-message'].includes(command ?? '')) throw new Error('Expected serve, once, worker, list, resolve-customer or resolve-message');
	const store = new OrdersStore(config.database, config.mode, config.sourceId, config.statusMode !== 'off');
	try { store.bindDestination(config.portalDomain, config.chatId); }
	catch (error) { store.close(); throw error; }
	if (command === 'serve') {
		const app = Fastify({ logger: false });
		app.addHook('onClose', async () => store.close());
		await registerOrdersRoute(app, config, store);
		if (config.statusMode !== 'off') await registerOrderStatusRoute(app, config, store, new BitrixOrderStatusCrm(webhookCall(config.webhook!)));
		app.get('/health', async () => ({ ok: true, integration: 'umniydom-orders', mode: config.mode }));
		app.get('/ready', async () => { store.db.prepare('SELECT 1').get(); return { ok: true }; });
		try {
			const address = await app.listen(receiverAddress());
			console.log(`Orders ${config.mode} receiver: ${address}`);
		} catch (error) { await app.close(); throw error; }
		for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
		return;
	}
	try {
		if (command === 'list') { console.log(JSON.stringify(store.list(), null, 2)); return; }
		if (command === 'resolve-customer' || command === 'resolve-message') {
			const receipt = process.argv[3] ?? '';
			if (!/^inbox-[a-f0-9-]+$/i.test(receipt)) throw new Error('Invalid receipt');
			if (command === 'resolve-customer') {
				const kind = process.argv[4];
				const id = process.argv[5] ?? '';
				if (!['CONTACT', 'COMPANY', 'LEAD'].includes(kind ?? '') || !/^[1-9]\d*$/.test(id)) throw new Error('Expected CONTACT|COMPANY|LEAD and verified ID');
				store.resolveCustomer(receipt, { kind, id } as Customer);
			} else {
				const id = process.argv[4] ?? '';
				if (!/^[1-9]\d*$/.test(id)) throw new Error('Expected verified message ID');
				store.resolveMessage(receipt, id);
			}
			console.log('Review recorded; processing will resume from the saved stage');
			return;
		}
		if (config.processor === 'off') { console.log('Orders processor is off'); return; }
		const crm = config.processor === 'mock' ? new MockOrdersCrm(store) : new BitrixOrdersCrm(config, webhookCall(config.webhook!));
		let stopped = false;
		let wake: (() => void) | undefined;
		const stop = () => { stopped = true; wake?.(); };
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
		try {
			do {
				const processed = await processOne(store, crm, config.portalDomain);
				if (command === 'once' || stopped) break;
				await new Promise<void>(resolve => {
					const timer = setTimeout(resolve, processed ? 1000 : 15000);
					wake = () => { clearTimeout(timer); resolve(); };
				});
			} while (!stopped);
		} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
	} finally { store.close(); }
}

main().catch(() => { console.error('Orders command failed. Check configuration and queue state; sensitive error details suppressed.'); process.exitCode = 1; });
