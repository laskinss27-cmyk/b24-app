import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnalyticsKeyStore, analyticsStorePath } from './store.js';
import { readAnalyticsCatalog, type AnalyticsCatalog } from './catalog.js';

const PATH = '/api/analytics/v1/catalog';
const TTL = 60_000, RETAIN = 5 * 60_000;
const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), cursor: z.string().regex(/^[a-f0-9-]{36}:[0-9]{1,8}$/).optional() }).strict();
interface Snapshot { id: string; at: number; data: AnalyticsCatalog }

export function registerAnalyticsReadRoutes(app: FastifyInstance, options: {
	store?: AnalyticsKeyStore; load?: () => Promise<AnalyticsCatalog>; now?: () => number;
} = {}): void {
	let keys = options.store;
	const store = (): AnalyticsKeyStore => keys ??= new AnalyticsKeyStore(analyticsStorePath());
	const load = options.load ?? readAnalyticsCatalog, now = options.now ?? Date.now;
	const snapshots = new Map<string, Snapshot>();
	const rates = new Map<string, { start: number; count: number }>();
	let latest: Snapshot | undefined, building: Promise<Snapshot> | undefined, failedUntil = 0;
	app.addHook('onClose', async () => { if (!options.store) keys?.close(); });
	const snapshot = async (): Promise<Snapshot> => {
		if (latest && now() - latest.at < TTL) return latest;
		if (now() < failedUntil) throw new Error('Source cooling down');
		if (!building) building = load().then(data => {
			const entry = { id: randomUUID(), at: now(), data };
			for (const [id, value] of snapshots) if (now() - value.at >= RETAIN) snapshots.delete(id);
			while (snapshots.size >= 5) snapshots.delete(snapshots.keys().next().value!);
			snapshots.set(entry.id, entry); latest = entry; return entry;
		}).catch(error => { failedUntil = now() + 10_000; throw error; }).finally(() => { building = undefined; });
		return building;
	};
	app.get(PATH, { exposeHeadRoute: false, logLevel: 'warn' }, async (req, reply) => {
		reply.header('Cache-Control', 'no-store');
		let actor;
		try { actor = store().authenticate(req.headers.authorization); }
		catch { return reply.code(503).send({ error: 'access_store_unavailable' }); }
		if (!actor) return reply.code(401).send({ error: 'invalid_api_key' });
		for (const [id, rate] of rates) if (now() - rate.start >= TTL) rates.delete(id);
		const rate = rates.get(actor.id) ?? { start: now(), count: 0 };
		rates.set(actor.id, rate);
		if (++rate.count > 60) return reply.header('Retry-After', Math.max(1, Math.ceil((TTL - now() + rate.start) / 1000))).code(429).send({ error: 'rate_limit' });
		const parsed = query.safeParse(req.query);
		if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', message: 'Only limit (1..500) and cursor are accepted' });
		try {
			let entry: Snapshot | undefined, offset = 0;
			if (parsed.data.cursor) {
				const [id, rawOffset] = parsed.data.cursor.split(':');
				entry = snapshots.get(id!); offset = Number(rawOffset);
				if (!entry || now() - entry.at >= RETAIN) return reply.code(410).send({ error: 'snapshot_expired', message: 'Restart without cursor' });
				if (offset > entry.data.products.length) return reply.code(400).send({ error: 'invalid_cursor' });
			} else entry = await snapshot();
			const rows = entry.data.products.slice(offset, offset + parsed.data.limit), end = offset + rows.length;
			app.log.info({ clientId: actor.id, ownerId: actor.ownerId, snapshotId: entry.id, offset, count: rows.length }, '[analytics-read] catalog');
			return { apiVersion: 1, snapshotId: entry.id, readStartedAt: entry.data.readStartedAt, generatedAt: entry.data.generatedAt,
				currency: 'RUB', quantityMeaning: 'physical_stock_including_reserved', priceMeaning: 'current_catalog_purchase_price',
				warehouses: entry.data.warehouses, products: rows, total: entry.data.products.length,
				nextCursor: end < entry.data.products.length ? `${entry.id}:${end}` : null };
		} catch {
			app.log.warn({ clientId: actor.id }, '[analytics-read] catalog source unavailable');
			return reply.code(503).send({ error: 'source_unavailable' });
		}
	});
}
