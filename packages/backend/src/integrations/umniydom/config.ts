import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const schema = z.object({
	mode: z.enum(['off', 'sandbox', 'production']),
	secret: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
	sourceId: z.string().uuid(),
	database: z.string().min(1),
	processor: z.enum(['off', 'mock', 'live']),
	chatId: z.string().regex(/^chat[1-9]\d*$/),
	portalDomain: z.string().regex(/^[a-z0-9.-]+$/i),
	webhook: z.string().optional(),
	robotId: z.string().regex(/^[1-9]\d*$/).optional(),
	leadStatus: z.string().min(1).optional(),
	statusMode: z.enum(['off', 'sandbox', 'production']),
	statusSecret: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
	statusDealCategories: z.array(z.string().regex(/^\d+$/)).max(20).refine(values => new Set(values).size === values.length),
});
export type OrdersConfig = z.infer<typeof schema>;

function secretValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const file = env[name + '_FILE'];
	if (!file) return env[name] || undefined;
	if (env[name]) throw new Error('Configure only one secret source for ' + name);
	try { return readFileSync(file, 'utf8').trim(); }
	catch { throw new Error('Cannot read secret file for ' + name); }
}

export function receiverAddress(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
	const host = env['UMNIYDOM_ORDERS_HOST'] ?? '127.0.0.1';
	const rawPort = env['UMNIYDOM_ORDERS_PORT'] ?? '3091';
	if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host) || !/^\d+$/.test(rawPort)) throw new Error('Invalid receiver address');
	const port = Number(rawPort);
	if (port > 65535 || (port === 0 && env['UMNIYDOM_ORDERS_MODE'] !== 'sandbox')) throw new Error('Invalid receiver port');
	return { host, port };
}

export function loadOrdersConfig(env: NodeJS.ProcessEnv = process.env): OrdersConfig | null {
	const mode = env['UMNIYDOM_ORDERS_MODE'] ?? 'off';
	if (mode === 'off') return null;
	const parsed = schema.safeParse({
		mode, secret: secretValue(env, 'UMNIYDOM_ORDERS_SECRET'), sourceId: env['UMNIYDOM_ORDERS_SOURCE_ID'],
		database: env['UMNIYDOM_ORDERS_DB'], processor: env['UMNIYDOM_ORDERS_PROCESSOR'] ?? 'off',
		chatId: env['UMNIYDOM_ORDERS_CHAT_ID'] ?? 'chat19572',
		portalDomain: env['PORTAL_DOMAIN'] ?? 'portal.example.bitrix24.ru',
		webhook: secretValue(env, 'UMNIYDOM_ORDERS_CRM_WEBHOOK'),
		robotId: env['UMNIYDOM_ORDERS_ROBOT_ID'] || undefined,
		leadStatus: env['UMNIYDOM_ORDERS_LEAD_STATUS'] || undefined,
		statusMode: env['UMNIYDOM_ORDER_STATUS_MODE'] ?? 'off',
		statusSecret: secretValue(env, 'UMNIYDOM_ORDER_STATUS_SECRET'),
		statusDealCategories: (env['UMNIYDOM_ORDER_STATUS_DEAL_CATEGORIES'] ?? '').split(',').map(value => value.trim()).filter(Boolean),
	});
	// Never print validation input or a webhook URL.
	if (!parsed.success) throw new Error('Invalid orders configuration: ' + parsed.error.issues.map(i => i.path.join('.')).join(', '));
	const config = parsed.data;
	if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Orders integration requires Node.js 24+');
	if (config.database === ':memory:') throw new Error('Orders receiver requires a persistent database path');
	config.database = resolve(config.database);
	if (mode === 'sandbox' && config.processor === 'live') throw new Error('Sandbox cannot use live CRM');
	if (config.statusMode !== 'off' && config.statusMode !== mode) throw new Error('Order status mode must match orders mode');
	if (config.statusMode !== 'off' && !config.statusSecret) throw new Error('Order status requires a dedicated secret');
	if (config.statusMode !== 'off' && !config.robotId) throw new Error('Order status requires the verified robot ID');
	if (config.statusMode !== 'off' && config.statusDealCategories.length === 0) throw new Error('Order status requires verified deal categories');
	if (mode === 'production') {
		if (config.processor === 'mock') throw new Error('Production cannot use mock CRM');
		if (!env['PUBLIC_BASE_URL']?.startsWith('https://')) throw new Error('Production requires an HTTPS public entry point');
	}
	const webhookOwner = (webhook: string, description: string): string => {
		let url: URL;
		try { url = new URL(webhook); } catch { throw new Error('Invalid ' + description); }
		const match = url.pathname.match(/^\/rest\/(\d+)\/[^/]+\/?$/);
		if (url.protocol !== 'https:' || url.hostname !== config.portalDomain || url.username || url.password || url.search || url.hash || !match) throw new Error('Invalid ' + description);
		return match[1]!;
	};
	if (config.processor === 'live' || config.statusMode !== 'off') {
		if (!config.webhook) throw new Error('Live CRM access requires a dedicated webhook');
		webhookOwner(config.webhook, 'orders CRM webhook');
	}
	if (config.processor === 'live') {
		if (!config.robotId || !config.leadStatus) throw new Error('Live processing requires verified robot ID and lead status');
	}
	return config;
}
