import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { fetchErpStoreStockFull } from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairStoreStockRoute(app: FastifyInstance, clientFrom: RepairClientFrom): void {
	// Остатки склада из ядра — пикер аппарата для предпродажного (выбираем товар со склада-источника).
	// Ремонтные позиции (строковый код) сюда не попадают — fetchErpStoreStockFull берёт только числовые коды.
	app.post('/api/repairs/store-stock', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { store?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const store = String(b.store ?? '').trim();
		if (!store) return reply.code(400).send({ ok: false, error: 'не указан склад' });
		try {
			const rows = await fetchErpStoreStockFull(erp, store);
			return { ok: true, items: rows.map((r) => ({ productId: r.productId, name: r.name, qty: r.book })) };
		} catch (err) {
			app.log.error({}, `[api/repairs/store-stock] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
