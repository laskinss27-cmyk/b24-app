import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import {
	createMarketplaceSale,
	listActiveStoreTitles,
	listMarketplaceOperations,
} from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { canManageStock, validateFreeStock } from './api-stock.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

const MARKETPLACES = ['Озон', 'Wildberries', 'Яндекс Маркет'] as const;
const MARKETPLACE_STORE_NAMES = ['Shelly', 'Маркетплейс'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeTitle = (value: string): string =>
	value.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');

function errInfo(error: unknown): string {
	return error instanceof B24ApiError
		? `${error.code}: ${error.description ?? ''}`
		: String(error instanceof Error ? error.message : error);
}

function marketplaceStores(stores: string[]): string[] {
	const allowed = new Set(MARKETPLACE_STORE_NAMES.map(normalizeTitle));
	return stores.filter((store) => allowed.has(normalizeTitle(store)));
}

export function registerApiMarketplacesRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	app.post('/api/marketplaces/form-data', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		try {
			const [stores, canCreate] = await Promise.all([
				listActiveStoreTitles(erp),
				canManageStock(client),
			]);
			return {
				ok: true,
				marketplaces: MARKETPLACES,
				stores: marketplaceStores(stores),
				missingStores: MARKETPLACE_STORE_NAMES.filter((required) =>
					!stores.some((store) => normalizeTitle(store) === normalizeTitle(required))),
				canCreate,
			};
		} catch (error) {
			app.log.error({}, `[api/marketplaces/form-data] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/marketplaces/list', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { from?: unknown; to?: unknown };
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		const opts: { from?: string; to?: string } = {};
		if (typeof body.from === 'string' && DATE_RE.test(body.from)) opts.from = body.from;
		if (typeof body.to === 'string' && DATE_RE.test(body.to)) opts.to = body.to;
		try {
			return { ok: true, rows: await listMarketplaceOperations(erp, opts) };
		} catch (error) {
			app.log.error({}, `[api/marketplaces/list] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/marketplaces/sale', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		try {
			if (!(await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'проводить реализации может только снабжение' });
			}
			const marketplace = String(body['marketplace'] ?? '').trim();
			if (!(MARKETPLACES as readonly string[]).includes(marketplace)) {
				return reply.code(400).send({ ok: false, error: 'неверный маркетплейс' });
			}
			const storeTitle = String(body['storeTitle'] ?? '').trim();
			const activeStores = await listActiveStoreTitles(erp);
			const allowedStores = marketplaceStores(activeStores);
			const resolvedStore = allowedStores.find((store) =>
				normalizeTitle(store) === normalizeTitle(storeTitle));
			if (!resolvedStore) {
				return reply.code(400).send({ ok: false, error: 'для реализации доступен только склад Shelly или Маркетплейс' });
			}
			const postingDate = String(body['postingDate'] ?? '').trim();
			if (!DATE_RE.test(postingDate)) {
				return reply.code(400).send({ ok: false, error: 'неверная дата реализации' });
			}
			const lines = (Array.isArray(body['lines']) ? body['lines'] as Array<Record<string, unknown>> : [])
				.map((line) => ({
					productId: Number(line['productId']),
					itemName: String(line['itemName'] ?? '').trim(),
					qty: Number(line['qty']),
					rate: Number(line['rate']),
				}))
				.filter((line) =>
					Number.isInteger(line.productId)
					&& line.productId > 0
					&& line.qty > 0
					&& line.rate >= 0);
			if (!lines.length) return reply.code(400).send({ ok: false, error: 'добавьте товары в реализацию' });
			await validateFreeStock(client, erp, lines.map((line) => ({
				productId: line.productId,
				qty: line.qty,
				fromStore: resolvedStore,
			})));
			const result = await createMarketplaceSale(erp, {
				marketplace,
				storeTitle: resolvedStore,
				postingDate,
				lines,
			});
			app.log.info({ name: result.name, title: result.title, marketplace, storeTitle: resolvedStore }, '[api/marketplaces/sale] submitted');
			return { ok: true, ...result };
		} catch (error) {
			app.log.error({}, `[api/marketplaces/sale] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
