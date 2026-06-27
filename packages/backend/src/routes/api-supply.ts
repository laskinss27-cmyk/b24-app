import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { listSupplyOrders } from '../erp/operations.js';

/**
 * API рабочего места «Снаб». Источник спроса — заказы (Sales Order) ядра по сделкам.
 *  - /api/supply/orders — все заказы из ядра (позиции + остатки по складам) + статус/название сделки из Б24.
 * Канарейку режет фронт (Supply.tsx). Токен юзера, домен — allowlist портала.
 */
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerApiSupplyRoute(app: FastifyInstance): void {
	const clientFrom = (b: AuthBody): B24Client | null => {
		if (!b.domain || !b.accessToken) return null;
		if (normalizeDomain(b.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: b.domain, accessToken: b.accessToken } });
	};

	app.post('/api/supply/orders', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return { ok: true, orders: [] as unknown[] };
		try {
			const orders = await listSupplyOrders(erp);
			// Статус/название — из сделки Б24 (одним батч-вызовом по списку dealId).
			const dealIds = [...new Set(orders.map((o) => Number(o.dealId)).filter((n) => Number.isInteger(n) && n > 0))];
			const dealMap = new Map<number, { title: string; closed: boolean }>();
			if (dealIds.length) {
				const deals = await client.call<Array<Record<string, unknown>>>('crm.deal.list', {
					filter: { '@ID': dealIds }, select: ['ID', 'TITLE', 'CLOSED', 'STAGE_SEMANTIC_ID'],
				}).catch(() => [] as Array<Record<string, unknown>>);
				for (const d of deals ?? []) {
					dealMap.set(Number(d['ID']), { title: String(d['TITLE'] ?? ''), closed: String(d['CLOSED']) === 'Y' });
				}
			}
			const enriched = orders.map((o) => {
				const d = dealMap.get(Number(o.dealId));
				return { ...o, dealTitle: d?.title ?? '', closed: d?.closed ?? false };
			});
			app.log.info({ orders: enriched.length }, '[api/supply/orders] ok');
			return { ok: true, orders: enriched };
		} catch (err) {
			app.log.error({}, `[api/supply/orders] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
