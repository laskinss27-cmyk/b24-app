import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { amendSubmittedStockDocument, ensureSupplier, fetchCoreDocDetail } from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { stockAccess } from './api-stock-access.js';
import { stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';
import { validateFreeStock } from './api-stock-availability.js';
import type { CoreDocDetail } from '../erp/operations.js';

function eventActor(req: FastifyRequest, fallback: { id: string; name: string }): { id: string; name: string } {
	return req.appAccess?.user ?? fallback;
}

function historyForDocument(events: Awaited<ReturnType<FastifyInstance['operationLog']['list']>>, name: string) {
	const names = new Set([name]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const event of events) {
			if (!event.documents?.some((document) => names.has(document))) continue;
			for (const document of event.documents) {
				if (!names.has(document)) { names.add(document); changed = true; }
			}
		}
	}
	return events.filter((event) => event.documents?.some((document) => names.has(document)));
}

export async function stockDocumentHistory(app: FastifyInstance, name: string) {
	return historyForDocument(await app.operationLog.list({ area: 'stock_documents', limit: 500 }), name);
}

function describeChanges(before: CoreDocDetail, body: Record<string, unknown>): string {
	const changes: string[] = [];
	const nextDate = String(body['date'] ?? '');
	const nextSupplier = String(body['supplier'] ?? '');
	const nextReason = String(body['reason'] ?? '');
	const nextNote = String(body['note'] ?? '');
	if (before.date !== nextDate) changes.push(`дата: ${before.date} → ${nextDate}`);
	if (before.supplier !== nextSupplier && nextSupplier) changes.push(`поставщик: ${before.supplier || '—'} → ${nextSupplier}`);
	if (before.reason !== nextReason) changes.push(`причина: ${before.reason || '—'} → ${nextReason || '—'}`);
	if (before.note !== nextNote) changes.push(`примечание: ${before.note || '—'} → ${nextNote || '—'}`);
	const nextLines = Array.isArray(body['lines']) ? body['lines'] as Array<Record<string, unknown>> : [];
	const oldByRow = new Map(before.items.map((line) => [line.rowId, line]));
	const retained = new Set<string>();
	for (const line of nextLines) {
		const rowId = String(line['rowId'] ?? '');
		const old = rowId ? oldByRow.get(rowId) : undefined;
		const product = String(line['productId'] ?? '');
		if (!old) { changes.push(`добавлен товар #${product}, ${Number(line['qty'])} шт.`); continue; }
		retained.add(rowId);
		const lineChanges: string[] = [];
		if (Math.abs(old.qty - Number(line['qty'])) > 0.000001) lineChanges.push(`кол-во ${old.qty} → ${Number(line['qty'])}`);
		if (old.store !== String(line['store'] ?? '')) lineChanges.push(`склад ${old.store} → ${String(line['store'] ?? '')}`);
		if (before.kind === 'receipt' && Math.abs(old.rate - Number(line['rate'] ?? 0)) > 0.005) lineChanges.push(`цена ${old.rate} → ${Number(line['rate'] ?? 0)} ₽`);
		if (lineChanges.length) changes.push(`${old.itemName || `#${old.productId}`}: ${lineChanges.join(', ')}`);
	}
	for (const old of before.items) if (old.rowId && !retained.has(old.rowId)) changes.push(`удалён ${old.itemName || `#${old.productId}`}, ${old.qty} шт.`);
	return changes.length ? changes.join('; ') : 'без изменения значений';
}

export function registerStockDocumentAmendRoute(app: FastifyInstance): void {
	app.post('/api/stock/amend', async (req, reply) => {
		const body = (req.body ?? {}) as StockAuthBody & Record<string, unknown>;
		const client = stockClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const doctype = String(body['doctype'] ?? '').trim();
		const name = String(body['name'] ?? '').trim();
		const access = await stockAccess(client);
		if (!appPermission(req, 'stock.edit_submitted', access.canManage)) {
			return reply.code(403).send({ ok: false, error: 'нет права исправлять проведённые документы' });
		}
		try {
			const before = await fetchCoreDocDetail(erp, doctype, name);
			if (before.kind === 'issue') {
				const nextLines = (Array.isArray(body['lines']) ? body['lines'] as Array<Record<string, unknown>> : []).map((line) => ({
					productId: Number(line['productId']), qty: Number(line['qty']), fromStore: String(line['store'] ?? ''),
				}));
				await validateFreeStock(client, erp, nextLines, before.items.map((line) => ({ productId: line.productId, qty: line.qty, fromStore: line.store })), app.reservationRuntime);
			}
			const supplierInput = String(body['supplier'] ?? '').trim();
			const supplier = supplierInput && doctype === 'Purchase Receipt' ? await ensureSupplier(erp, supplierInput) : supplierInput;
			const result = await amendSubmittedStockDocument(erp, {
				doctype,
				name,
				date: String(body['date'] ?? ''),
				...(supplier ? { supplier } : {}),
				reason: String(body['reason'] ?? ''),
				note: String(body['note'] ?? ''),
				lines: (Array.isArray(body['lines']) ? body['lines'] as Array<Record<string, unknown>> : []).map((line) => ({
					rowId: String(line['rowId'] ?? ''),
					sourceRow: String(line['sourceRow'] ?? ''),
					productId: Number(line['productId']),
					qty: Number(line['qty']),
					store: String(line['store'] ?? '').trim(),
					rate: Number(line['rate'] ?? 0),
				})),
			});
			const detail = await fetchCoreDocDetail(erp, doctype, result.name);
			await app.operationLog.record({
				area: 'stock_documents', operation: 'amend', outcome: 'success',
				summary: `Исправлен проведённый документ ${result.previousName} → ${result.name}: ${describeChanges(before, body)}`,
				actor: eventActor(req, access.actor), documents: [result.previousName, result.name],
				details: { kind: result.kind, previousDocument: result.previousName, newDocument: result.name, lineCount: detail.items.length },
			});
			app.log.info({ doctype, previousName: result.previousName, name: result.name }, '[api/stock/amend] ok');
			return { ok: true, ...result };
		} catch (error) {
			const message = stockErrorInfo(error);
			await app.operationLog.record({
				area: 'stock_documents', operation: 'amend', outcome: 'failure',
				summary: `Не удалось исправить проведённый документ ${name}: ${message}`,
				actor: eventActor(req, access.actor), documents: name ? [name] : [], details: { documentType: doctype },
			});
			app.log.error({ doctype, name }, `[api/stock/amend] failed — ${message}`);
			return reply.code(200).send({ ok: false, error: message });
		}
	});
}
