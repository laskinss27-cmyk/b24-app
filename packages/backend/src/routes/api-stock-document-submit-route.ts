import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { listActiveStoreTitles, submitDoc } from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { canManageStock } from './api-stock-access.js';
import { ReservationService } from '../reservations/service.js';
import { stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';

export function registerStockDocumentSubmitRoute(app: FastifyInstance): void {
	app.post('/api/stock/submit', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & { kind?: unknown; name?: unknown; doctype?: unknown };
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const name = String(b.name ?? '').trim();
		if (!name) return reply.code(400).send({ ok: false, error: 'нет имени документа' });
		const doctype = b.kind === 'receipt'
			? (b.doctype === 'Stock Entry' ? 'Stock Entry' : 'Purchase Receipt')
			: b.kind === 'issue' ? 'Stock Entry' : null;
		if (!doctype) return reply.code(400).send({ ok: false, error: 'kind должен быть receipt|issue' });
		try {
			if (!appPermission(req, 'stock.post_documents', await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'проводить складские документы может только снабжение' });
			}
			let issueLines: Array<{ productId: number; qty: number; fromStore: string }> = [];
			if (b.kind === 'issue') {
				const doc = await erp.get<Record<string, unknown>>('Stock Entry', name);
				const stores = await listActiveStoreTitles(erp);
				const rawLines = Array.isArray(doc?.['items']) ? doc?.['items'] as Array<Record<string, unknown>> : [];
				issueLines = rawLines
					.map((line) => {
						const warehouse = String(line['s_warehouse'] ?? '');
						const fromStore = stores.find((store) => warehouse === store || warehouse.startsWith(`${store} - `)) ?? '';
						return { productId: Number(line['item_code']), qty: Number(line['qty']), fromStore };
					})
					.filter((line) => Number.isInteger(line.productId) && line.productId > 0 && line.qty > 0 && line.fromStore);
				if (issueLines.length !== rawLines.length) throw new Error('не удалось определить склад строк списания');
			}
			if (b.kind === 'receipt' && doctype === 'Stock Entry') {
				const document = await erp.get<Record<string, unknown>>('Stock Entry', name);
				if (String(document?.['stock_entry_type'] ?? '') !== 'Material Receipt') {
					throw new Error('как оприходование можно провести только Stock Entry типа Material Receipt');
				}
			}
			await submitDoc(erp, doctype, name);
			if (issueLines.length && app.reservationRuntime?.canWrite) {
				await new ReservationService(app.reservationRuntime).reconcilePhysicalFor(erp, issueLines.map((line) => ({ productId: line.productId, storeTitle: line.fromStore })))
					.catch((error) => app.log.error({ name }, `[reservations] write-off submitted; reconcile required — ${stockErrorInfo(error)}`));
			}
			app.log.info({ name, doctype }, '[api/stock/submit] ok');
			return { ok: true, name };
		} catch (e) {
			app.log.error({}, `[api/stock/submit] failed — ${stockErrorInfo(e)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(e) });
		}
	});
}
