import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import {
	listActiveStoreTitles, ensureSupplier, createReceiptDraft, createWriteOffDraft, submitDoc,
	updateCoreCatalogPrices,
} from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { canManageStock } from './api-stock-access.js';
import { registerStockAssortmentRoutes } from './api-stock-assortment-routes.js';
import { validateFreeStock } from './api-stock-availability.js';
import { registerStockCatalogRoutes } from './api-stock-catalog-routes.js';
import { registerStockMovementRoutes } from './api-stock-movement-routes.js';
import { stockClientFrom, stockErrorInfo as errInfo } from './api-stock-route-helpers.js';
import { registerStockTurnoverRoutes } from './api-stock-turnover-routes.js';
import type { StockAuthBody as AuthBody, StockIssueLine as IssueLine, StockReceiptLine as ReceiptLine } from './api-stock-types.js';

export { canManageStock } from './api-stock-access.js';
export { validateFreeStock } from './api-stock-availability.js';

/**
 * API окна «Складской учёт».
 *  - /api/stock/movements   — read-only журнал (списания/оприходования/реализации);
 *  - /api/stock/form-data   — справочники для форм создания (склады, поставщики, право);
 *  - /api/stock/search-items — поиск товаров каталога ядра (пикер позиций);
 *  - /api/stock/create      — создать ЧЕРНОВИК прихода/списания (Provести — отдельно);
 *  - /api/stock/submit      — провести черновик (двигает остатки ядра).
 * Перемещения — отдельный роут /api/transfers/*.
 * Авторизация — Б24-oauth (домен из allowlist). Создание/проведение — снабжение и руководители.
 */
export function registerApiStockRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => stockClientFrom(app, body);
	registerStockMovementRoutes(app);
	registerStockTurnoverRoutes(app);
	registerStockAssortmentRoutes(app);
	registerStockCatalogRoutes(app);

	// Создать ЧЕРНОВИК: kind 'receipt' (Приход) | 'issue' (Списание). Перемещения — /api/transfers.
	app.post('/api/stock/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
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
				const lines: ReceiptLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
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

			// issue
			const fromStore = String(b['fromStore'] ?? '').trim();
			if (!fromStore) return reply.code(400).send({ ok: false, error: 'не выбран склад списания' });
			const reason = String(b['reason'] ?? '').trim();
			const note = String(b['note'] ?? '').trim();
			const lines: IssueLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
				.map((l) => ({ productId: Number(l['productId']), qty: Number(l['qty']) }))
				.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
			if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
			await validateFreeStock(client, erp, lines.map((line) => ({ ...line, fromStore })));
			const { name } = await createWriteOffDraft(erp, {
				...(reason ? { reason } : {}),
				...(note ? { note } : {}),
				lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, fromStore })),
			});
			app.log.info({ name, lines: lines.length }, '[api/stock/create] issue draft');
			return { ok: true, kind, name };
		} catch (e) {
			app.log.error({}, `[api/stock/create] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Провести черновик: kind 'receipt' (Purchase Receipt) | 'issue' (Stock Entry).
	app.post('/api/stock/submit', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { kind?: unknown; name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const name = String(b.name ?? '').trim();
		if (!name) return reply.code(400).send({ ok: false, error: 'нет имени документа' });
		const doctype = b.kind === 'receipt' ? 'Purchase Receipt' : b.kind === 'issue' ? 'Stock Entry' : null;
		if (!doctype) return reply.code(400).send({ ok: false, error: 'kind должен быть receipt|issue' });
		try {
			if (!appPermission(req, 'stock.post_documents', await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'проводить складские документы может только снабжение' });
			}
			if (b.kind === 'issue') {
				const doc = await erp.get<Record<string, unknown>>('Stock Entry', name);
				const stores = await listActiveStoreTitles(erp);
				const rawLines = Array.isArray(doc?.['items']) ? doc?.['items'] as Array<Record<string, unknown>> : [];
				const lines = rawLines
					.map((line) => {
						const warehouse = String(line['s_warehouse'] ?? '');
						const fromStore = stores.find((store) => warehouse === store || warehouse.startsWith(`${store} - `)) ?? '';
						return { productId: Number(line['item_code']), qty: Number(line['qty']), fromStore };
					})
					.filter((line) => Number.isInteger(line.productId) && line.productId > 0 && line.qty > 0 && line.fromStore);
				if (lines.length !== rawLines.length) throw new Error('не удалось проверить склад строк списания');
				await validateFreeStock(client, erp, lines);
			}
			await submitDoc(erp, doctype, name);
			app.log.info({ name, doctype }, '[api/stock/submit] ok');
			return { ok: true, name };
		} catch (e) {
			app.log.error({}, `[api/stock/submit] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});
}
