import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { fetchBasePrices, legacyB24CompositionDisabled } from '../deal-product-catalog.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealLegacyProductRoute(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Добавить одну товарную строку в сделку (не перезаписывая существующие).
	app.post('/api/deal/add-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; productId?: unknown; quantity?: unknown; price?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (legacyB24CompositionDisabled()) return reply.code(410).send({ ok: false, error: 'товарный состав сделки редактируется только в ядре' });

		const dealId = Number(b.dealId);
		const productId = Number(b.productId);
		const quantity = Number(b.quantity);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		if (!Number.isFinite(quantity) || quantity <= 0) return reply.code(400).send({ ok: false, error: 'bad quantity' });

		try {
			// Цена: из запроса (если задана) или розничная BASE.
			let price = Number(b.price);
			if (!Number.isFinite(price) || price < 0) price = (await fetchBasePrices(client, [productId])).get(productId) ?? 0;

			const res = await client.call<{ productRow?: Record<string, unknown> }>('crm.item.productrow.add', {
				fields: { ownerType: 'D', ownerId: dealId, productId, price, quantity },
			});
			const row = res?.productRow;
			app.log.info({ dealId, productId, quantity }, '[api/deal/add-product] ok');
			return { ok: true, row: { id: Number(row?.['id']), name: String(row?.['productName'] ?? ''), price: Number(row?.['price'] ?? price), quantity: Number(row?.['quantity'] ?? quantity) } };
		} catch (err) {
			app.log.error({ dealId, productId }, `[api/deal/add-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
