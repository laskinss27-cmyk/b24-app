import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { ErpApiError, ErpClient } from '../erp/client.js';
import { DEAL_FIELD } from '../erp/erp-setup.js';
import {
	cancelSubmittedStockDoc,
	type CancellableStockDocumentKind,
	type CancellableStockDocumentType,
} from '../erp/operations.js';
import { b24StoreTitle, erpContext } from '../erp/warehouse-context.js';
import { ReservationService } from '../reservations/service.js';
import { stockAccess } from './api-stock-access.js';
import { stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';

const KINDS = new Set<CancellableStockDocumentKind>(['issue', 'receipt', 'delivery', 'return']);
const DOCTYPES = new Set<CancellableStockDocumentType>(['Stock Entry', 'Purchase Receipt', 'Delivery Note']);

function readableCancelError(error: unknown): string {
	const raw = error instanceof ErpApiError
		? error.message.replace(/^ERPNext \[[^\]]+\]\s*\d*:\s*/i, '')
		: stockErrorInfo(error);
	if (/cannot cancel|linked|reference|submitted|depends|against/i.test(raw)) {
		return `Нельзя отменить проведение: документ уже используется другим проведённым документом. ${raw}`;
	}
	return raw;
}

function affectedReservationLines(document: Record<string, unknown>, doctype: CancellableStockDocumentType, kind: CancellableStockDocumentKind, abbrContext: Awaited<ReturnType<typeof erpContext>>): Array<{ productId: number; storeTitle: string }> {
	const items = Array.isArray(document['items']) ? document['items'] as Array<Record<string, unknown>> : [];
	const unique = new Map<string, { productId: number; storeTitle: string }>();
	for (const item of items) {
		const productId = Number(item['item_code']);
		const warehouse = doctype === 'Stock Entry'
			? String(item[kind === 'issue' ? 's_warehouse' : 't_warehouse'] ?? '')
			: String(item['warehouse'] ?? '');
		if (!Number.isInteger(productId) || productId <= 0 || !warehouse) continue;
		const storeTitle = b24StoreTitle(abbrContext, warehouse);
		unique.set(`${storeTitle}\u0000${productId}`, { productId, storeTitle });
	}
	return [...unique.values()];
}

export function registerStockDocumentCancelRoute(app: FastifyInstance): void {
	app.post('/api/stock/cancel-submission', async (req, reply) => {
		const body = (req.body ?? {}) as StockAuthBody & { kind?: unknown; doctype?: unknown; name?: unknown };
		const client = stockClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const kind = String(body.kind ?? '') as CancellableStockDocumentKind;
		const doctype = String(body.doctype ?? '') as CancellableStockDocumentType;
		const name = String(body.name ?? '').trim();
		if (!KINDS.has(kind) || !DOCTYPES.has(doctype) || !name) return reply.code(400).send({ ok: false, error: 'Некорректный документ' });
		let actor: { id: string; name: string } | undefined;
		try {
			const access = await stockAccess(client);
			if (!appPermission(req, 'stock.post_documents', access.canManage)) {
				return reply.code(403).send({ ok: false, error: 'Отменять проведение может только снабжение' });
			}
			const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {});
			const actorId = String(me?.ID ?? '').trim();
			if (actorId) actor = { id: actorId, name: `${String(me?.LAST_NAME ?? '').trim()} ${String(me?.NAME ?? '').trim()}`.trim() || `#${actorId}` };
			const erp = ErpClient.fromEnv();
			if (!erp) throw new Error('Ядро недоступно');
			const document = await cancelSubmittedStockDoc(erp, kind, doctype, name);
			let warning: string | null = null;
			if (app.reservationRuntime?.canWrite) {
				try {
					const context = await erpContext(erp);
					await new ReservationService(app.reservationRuntime).reconcilePhysicalFor(erp, affectedReservationLines(document, doctype, kind, context));
				} catch (error) {
					warning = 'Проведение отменено, но резервам требуется повторная сверка физического остатка.';
					app.log.error({ name, doctype }, `[reservations] document cancelled; reconcile required — ${stockErrorInfo(error)}`);
				}
			}
			const dealId = Number(document[DEAL_FIELD] ?? 0);
			await app.operationLog.record({
				area: 'supply', operation: 'cancel_stock_document_submission', outcome: 'success', level: 'warning',
				summary: `Отменено проведение ${doctype} ${name}.`, ...(actor ? { actor } : {}),
				...(Number.isInteger(dealId) && dealId > 0 ? { dealId } : {}), documents: [`${doctype} ${name}`],
				details: { kind, doctype, name, ...(warning ? { warning } : {}) },
			});
			return { ok: true, name, doctype, cancelled: true, warning };
		} catch (error) {
			const message = readableCancelError(error);
			await app.operationLog.record({
				area: 'supply', operation: 'cancel_stock_document_submission', outcome: 'failure', level: 'error',
				summary: `Не удалось отменить проведение ${doctype} ${name}: ${message}`,
				...(actor ? { actor } : {}), documents: [`${doctype} ${name}`], details: { kind, doctype, name, error: message.slice(0, 500) },
			});
			app.log.error({ name, doctype, kind }, `[api/stock/cancel-submission] failed — ${message}`);
			return reply.code(200).send({ ok: false, error: message });
		}
	});
}
