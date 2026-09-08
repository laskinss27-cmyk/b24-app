import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import {
	createReceiptDraft,
	createWriteOffDraft,
	ensureSupplier,
	updateCoreCatalogPrices,
} from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { canManageStock } from './api-stock-access.js';
import { stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody, StockIssueLine, StockReceiptLine } from './api-stock-types.js';

export function registerStockDocumentCreationRoute(app: FastifyInstance): void {
	app.post('/api/stock/create', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & Record<string, unknown>;
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const kind = b['kind'] === 'receipt' ? 'receipt' : b['kind'] === 'issue' ? 'issue' : null;
			if (!kind) return reply.code(400).send({ ok: false, error: 'kind должен быть receipt|issue' });
			const permissionId = kind === 'receipt' ? 'stock.create_receipt' : 'stock.create_issue';
			if (!appPermission(req, permissionId, await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'создавать складские документы может только снабжение' });
			}

			if (kind === 'receipt') {
				const toStore = String(b['toStore'] ?? '').trim();
				if (!toStore) return reply.code(400).send({ ok: false, error: 'не выбран склад прихода' });
				const lines: StockReceiptLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
					.map((l) => ({ productId: Number(l['productId']), qty: Number(l['qty']), purchase: Number(l['purchase'] ?? 0), retail: Number(l['retail'] ?? 0) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
				if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
				const supplierIn = String(b['supplier'] ?? '').trim();
				const supplier = supplierIn ? await ensureSupplier(erp, supplierIn) : undefined;
				const note = String(b['note'] ?? '').trim();
				const { name } = await createReceiptDraft(erp, {
					...(supplier ? { supplier } : {}),
					...(note ? { note } : {}),
					lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, toStore, rate: l.purchase })),
				});
				for (const line of lines) {
					const prices: { productId: number; retail?: number; purchase?: number } = { productId: line.productId };
					if (line.retail > 0) prices.retail = line.retail;
					if (line.purchase > 0) prices.purchase = line.purchase;
					if (prices.retail !== undefined || prices.purchase !== undefined) await updateCoreCatalogPrices(erp, prices);
				}
				app.log.info({ name, lines: lines.length }, '[api/stock/create] receipt draft');
				return { ok: true, kind, name };
			}

			const fromStore = String(b['fromStore'] ?? '').trim();
			if (!fromStore) return reply.code(400).send({ ok: false, error: 'не выбран склад списания' });
			const reason = String(b['reason'] ?? '').trim();
			const note = String(b['note'] ?? '').trim();
			const lines: StockIssueLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
				.map((l) => ({ productId: Number(l['productId']), qty: Number(l['qty']) }))
				.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
			if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
			const { name } = await createWriteOffDraft(erp, {
				...(reason ? { reason } : {}),
				...(note ? { note } : {}),
				lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, fromStore })),
			});
			app.log.info({ name, lines: lines.length }, '[api/stock/create] issue draft');
			return { ok: true, kind, name };
		} catch (e) {
			app.log.error({}, `[api/stock/create] failed — ${stockErrorInfo(e)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(e) });
		}
	});
}
