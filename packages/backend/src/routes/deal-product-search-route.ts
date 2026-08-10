import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import {
	CORE_ENGINEER_VISIT_SERVICE_ID,
	fetchBasePrices,
	VYEZD_PRODUCT_ID,
} from '../deal-product-catalog.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealProductSearchRoute(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Поиск товара по названию + розничная цена (для пикера «Добавить товар»).
	app.post('/api/deal/search-products', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { q?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const q = String(b.q ?? '').trim();
		if (q.length < 2) return { ok: true, products: [] as Array<{ id: number; name: string; price: number }> };
		try {
			const byName = new Map<string, { id: number; name: string }>();
			for (const iblockId of [24, 26]) {
				const res = await client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
					filter: { iblockId, '%name': q },
					select: ['id', 'iblockId', 'name'], // iblockId обязателен в select
					order: { id: 'ASC' },
				});
				for (const p of res?.products ?? []) {
					const name = String(p['name'] ?? '');
					const id = Number(p['id']);
					if (id === VYEZD_PRODUCT_ID) continue;
					if (name && id > 0 && !byName.has(name)) byName.set(name, { id, name });
				}
			}
			const list = [...byName.values()];
			if ('выезд инженера'.includes(q.toLowerCase()) || q.toLowerCase().includes('выезд') || q.toLowerCase().includes('инженер')) {
				list.unshift({ id: CORE_ENGINEER_VISIT_SERVICE_ID, name: 'Выезд инженера' });
			}
			const limited = list.slice(0, 30);
			const prices = await fetchBasePrices(client, limited.filter((p) => p.id !== CORE_ENGINEER_VISIT_SERVICE_ID).map((p) => p.id));
			const products = limited.map((p) => ({ ...p, price: p.id === CORE_ENGINEER_VISIT_SERVICE_ID ? 0 : (prices.get(p.id) ?? 0) }));
			app.log.info({ count: products.length }, '[api/deal/search-products] ok');
			return { ok: true, products };
		} catch (err) {
			app.log.error({}, `[api/deal/search-products] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
