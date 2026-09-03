import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { fetchCoreDocDetail, itemStockLedger, listCoreMovements } from '../erp/operations.js';
import { resolveDealOwners } from '../b24/deal-info.js';
import { stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';

export function registerStockMovementRoutes(app: FastifyInstance): void {
	app.post('/api/stock/movements', async (req, reply) => {
		const body = (req.body ?? {}) as StockAuthBody & { kind?: unknown; from?: unknown; to?: unknown; fullList?: unknown };
		const client = stockClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const kind = body.kind === 'receipt' ? 'receipt' : body.kind === 'delivery' ? 'delivery' : body.kind === 'return' ? 'return' : 'issue';
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
		const period: { from?: string; to?: string; productId?: number; fullList?: boolean } = {};
		if (isDate(body.from)) period.from = body.from;
		if (isDate(body.to)) period.to = body.to;
		const productId = Number((body as { productId?: unknown }).productId);
		if (Number.isInteger(productId) && productId > 0) period.productId = productId;
		if (body.fullList === true) period.fullList = true;
		try {
			const movements = await listCoreMovements(erp, kind, period);
			const owners = await resolveDealOwners(client, movements.map((movement) => movement.dealId));
			return { ok: true, kind, movements: movements.map((movement) => ({ ...movement, ownerName: owners.get(movement.dealId) ?? '' })) };
		} catch (error) {
			app.log.error({}, `[api/stock/movements] failed — ${stockErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(error) });
		}
	});

	app.post('/api/stock/doc', async (req, reply) => {
		const body = (req.body ?? {}) as StockAuthBody & { doctype?: unknown; name?: unknown };
		const client = stockClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const doctype = String(body.doctype ?? '').trim();
		const name = String(body.name ?? '').trim();
		if (!doctype || !name) return reply.code(400).send({ ok: false, error: 'нужны doctype и name' });
		try {
			const detail = await fetchCoreDocDetail(erp, doctype, name);
			const owners = await resolveDealOwners(client, [detail.dealId]);
			return { ok: true, detail: { ...detail, ownerName: owners.get(detail.dealId) ?? '' } };
		} catch (error) {
			app.log.error({}, `[api/stock/doc] failed — ${stockErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(error) });
		}
	});

	app.post('/api/stock/item-history', async (req, reply) => {
		const body = (req.body ?? {}) as StockAuthBody & { productId?: unknown };
		const client = stockClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const productId = Number(body.productId);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		try {
			return { ok: true, movements: await itemStockLedger(erp, productId) };
		} catch (error) {
			app.log.error({}, `[api/stock/item-history] failed — ${stockErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(error) });
		}
	});
}
