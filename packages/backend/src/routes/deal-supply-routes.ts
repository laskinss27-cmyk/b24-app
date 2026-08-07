import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { loadDealOrderInfo } from '../deal-order-info.js';
import { listCoreSupplyCards, listSupplyCards, type SupplyCard } from '../deal-supply-cards.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealSupplyRoutes(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Что уже отгружено по строкам сделки (для колонки «Отгружено» и остатков к отгрузке).
	app.post('/api/deal/shipped', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const [info, b24Supply, coreSupply] = await Promise.all([
				loadDealOrderInfo(client, dealId),
				listSupplyCards(client, dealId).catch(() => [] as SupplyCard[]),
				listCoreSupplyCards(dealId).catch(() => [] as SupplyCard[]),
			]);
			const supply = [...coreSupply, ...b24Supply];
			return {
				ok: true,
				orderId: info.orderId,
				shipped: Object.fromEntries(info.shipped),
				reserves: Object.fromEntries(info.reserves),
				shipments: info.shipments,
				payment: info.payment,
				sourceStoreId: info.sourceStoreId,
				supply,
				rows: [],
			};
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/shipped] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
