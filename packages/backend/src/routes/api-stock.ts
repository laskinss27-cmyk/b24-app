import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { listActiveStoreTitles, submitDoc } from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { canManageStock } from './api-stock-access.js';
import { registerStockAssortmentRoutes } from './api-stock-assortment-routes.js';
import { validateFreeStock } from './api-stock-availability.js';
import { registerStockCatalogRoutes } from './api-stock-catalog-routes.js';
import { registerStockDocumentCreationRoute } from './api-stock-document-creation-route.js';
import { registerStockMovementRoutes } from './api-stock-movement-routes.js';
import { stockClientFrom, stockErrorInfo as errInfo } from './api-stock-route-helpers.js';
import { registerStockTurnoverRoutes } from './api-stock-turnover-routes.js';
import type { StockAuthBody as AuthBody } from './api-stock-types.js';

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
	registerStockDocumentCreationRoute(app);

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
