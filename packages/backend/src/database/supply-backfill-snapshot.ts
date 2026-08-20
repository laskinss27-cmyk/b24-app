import { DEAL_FIELD } from '../erp/erp-setup.js';
import {
	SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
	SUPPLY_PURCHASE_ORDERED_AT_FIELD,
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
} from '../erp/supply-purchases.js';
import {
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_REQUEST_FIELD,
	SUPPLY_REQUEST_KEY_FIELD,
} from '../erp/stock-transfers.js';
import { parseTransferItem, type StoredTransfer } from '../transfers/model.js';
import { TRANSFER_DOCUMENT_FIELD, TRANSFER_PHASE_FIELD, type SupplyBackfillRawSources } from './supply-backfill-read.js';
import type {
	MirrorDocumentRef,
	MirrorLineRef,
	SupplyMirrorPlanIssue,
	SupplyMirrorSnapshot,
	SupplyMirrorSourceAllocation,
	SupplyMirrorSourceDocument,
	SupplyMirrorSourceLink,
} from './supply-backfill-types.js';

function text(value: unknown): string { return String(value ?? '').trim(); }
function numberOrNull(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function dealId(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
function rawLines(value: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(value['items']) ? value['items'] as Record<string, unknown>[] : [];
}
function docRef(documentType: MirrorDocumentRef['documentType'], externalId: unknown, externalSystem: MirrorDocumentRef['externalSystem'] = 'erpnext'): MirrorDocumentRef {
	return { externalSystem, documentType, externalId: text(externalId) };
}
function lineRef(document: MirrorDocumentRef, line: Record<string, unknown>, index: number): MirrorLineRef {
	const key = text(line['name']);
	return { document, ...(key ? { externalLineKey: key } : {}), lineOrdinal: index + 1 };
}
function issue(code: string, identity: string, message: string): SupplyMirrorPlanIssue {
	return { severity: 'error', code, identity, message };
}

function erpDocument(
	raw: Record<string, unknown>,
	type: MirrorDocumentRef['documentType'],
	observedAt: string,
	quantities: { planned?: string; request?: string; actual?: string },
): SupplyMirrorSourceDocument {
	const ref = docRef(type, raw['name']);
	return {
		...ref,
		externalRevisionKey: type === 'supply_request'
			? `${text(raw['name'])}@${text(raw['creation'])}`
			: text(raw[SUPPLY_REQUEST_KEY_FIELD]) || null,
		externalStatus: type === 'purchase_order' ? text(raw[SUPPLY_PURCHASE_STAGE_FIELD] ?? raw['status']) : text(raw['status']),
		externalDocstatus: numberOrNull(raw['docstatus']),
		bitrixDealId: dealId(raw[DEAL_FIELD]),
		sourceCreatedAt: text(raw['creation']) || null,
		sourceModifiedAt: text(raw['modified']) || null,
		observedAt,
		sourcePayload: raw,
		lines: rawLines(raw).map((line, index) => ({
			externalLineKey: text(line['name']) || null,
			lineOrdinal: index + 1,
			erpItemCode: text(line['item_code']),
			...(quantities.planned ? { plannedQty: numberOrNull(line[quantities.planned]) } : {}),
			...(quantities.request ? { requestQty: numberOrNull(line[quantities.request]) } : {}),
			...(quantities.actual ? { actualQty: numberOrNull(line[quantities.actual]) } : {}),
			sourceWarehouse: text(line['s_warehouse']) || null,
			targetWarehouse: text(line['warehouse'] ?? line['t_warehouse']) || null,
			sourceModifiedAt: text(line['modified']) || null,
			sourcePayload: line,
		})),
	};
}

function transferActualQty(transfer: StoredTransfer, productId: number): number | null {
	const actual = transfer.acceptedLines.length ? transfer.acceptedLines : transfer.receivedLines;
	if (!actual.length) return null;
	return actual.filter((line) => line.productId === productId).reduce((sum, line) => sum + line.qty, 0);
}

function transferDocument(raw: Record<string, unknown>, transfer: StoredTransfer, observedAt: string): SupplyMirrorSourceDocument {
	return {
		...docRef('transfer', transfer.id, 'bitrix'),
		externalRevisionKey: text(raw['DATE_MODIFY'] ?? raw['MODIFIED_BY']),
		externalStatus: transfer.status,
		externalDocstatus: transfer.status === 'canceled' ? 2 : transfer.status === 'posted' || transfer.status === 'received' ? 1 : 0,
		bitrixDealId: dealId(transfer.dealId),
		sourceCreatedAt: transfer.createdAt || text(raw['DATE_CREATE']) || null,
		sourceModifiedAt: text(raw['DATE_MODIFY']) || null,
		observedAt,
		sourcePayload: raw,
		lines: transfer.lines.map((line, index) => ({
			lineOrdinal: index + 1,
			erpItemCode: String(line.productId),
			plannedQty: line.qty,
			actualQty: transferActualQty(transfer, line.productId),
			sourceWarehouse: transfer.fromStore || null,
			targetWarehouse: transfer.toStore || null,
			sourcePayload: { ...line, actualQty: transferActualQty(transfer, line.productId) },
		})),
	};
}

function byItem(documents: SupplyMirrorSourceDocument[]): Map<string, Array<{ document: SupplyMirrorSourceDocument; line: SupplyMirrorSourceDocument['lines'][number] }>> {
	const out = new Map<string, Array<{ document: SupplyMirrorSourceDocument; line: SupplyMirrorSourceDocument['lines'][number] }>>();
	for (const document of documents) for (const line of document.lines) {
		const key = `${document.externalSystem}:${document.documentType}:${document.externalId}:${line.erpItemCode}`;
		out.set(key, [...(out.get(key) ?? []), { document, line }]);
	}
	return out;
}

function indexedLineRef(
	index: ReturnType<typeof byItem>,
	document: MirrorDocumentRef,
	itemCode: string,
	issues: SupplyMirrorPlanIssue[],
	evidenceIdentity: string,
): MirrorLineRef | null {
	const matches = index.get(`${document.externalSystem}:${document.documentType}:${document.externalId}:${itemCode}`) ?? [];
	if (matches.length !== 1) {
		issues.push(issue(matches.length ? 'ambiguous_line_match' : 'missing_line_match', evidenceIdentity, `${document.documentType} ${document.externalId}: item ${itemCode} matched ${matches.length} lines`));
		return null;
	}
	const match = matches[0]!;
	return {
		document,
		...(match.line.externalLineKey ? { externalLineKey: match.line.externalLineKey } : {}),
		lineOrdinal: match.line.lineOrdinal,
	};
}

function validateRequestKey(raw: Record<string, unknown>, requests: Map<string, Record<string, unknown>>, issues: SupplyMirrorPlanIssue[]): void {
	const requestName = text(raw[SUPPLY_REQUEST_FIELD]);
	if (!requestName) return;
	const request = requests.get(requestName);
	if (!request) return;
	const stored = text(raw[SUPPLY_REQUEST_KEY_FIELD]);
	const current = `${requestName}@${text(request['creation'])}`;
	if (stored && stored !== current) issues.push(issue('stale_request_key', text(raw['name']), `${stored} does not match ${current}`));
}

export function buildSupplyMirrorSnapshot(raw: SupplyBackfillRawSources, observedAt: string): SupplyMirrorSnapshot {
	const issues: SupplyMirrorPlanIssue[] = [];
	const requestsByName = new Map(raw.materialRequests.map((row) => [text(row['name']), row]));
	for (const row of [...raw.purchaseOrders, ...raw.purchaseReceipts, ...raw.stockEntries]) validateRequestKey(row, requestsByName, issues);

	const documents: SupplyMirrorSourceDocument[] = [
		...raw.materialRequests.map((row) => erpDocument(row, 'supply_request', observedAt, { request: 'qty' })),
		...raw.purchaseOrders.map((row) => erpDocument(row, 'purchase_order', observedAt, { planned: 'qty', request: SUPPLY_PURCHASE_REQUEST_QTY_FIELD })),
		...raw.purchaseReceipts.map((row) => erpDocument(row, 'purchase_receipt', observedAt, { actual: 'qty' })),
		...raw.stockEntries.map((row) => erpDocument(row, 'stock_entry', observedAt, { actual: 'qty' })),
	];
	const transfers = new Map<number, StoredTransfer>();
	let invalidTransfers = 0;
	for (const item of raw.transferItems) {
		const parsed = parseTransferItem(item);
		if (!parsed) {
			invalidTransfers += 1;
			issues.push(issue('invalid_transfer_record', text(item['ID'] ?? item['id']) || 'unknown', 'transfer JSON or ID is invalid'));
			continue;
		}
		let detail: Record<string, unknown> = {};
		try { detail = item['DETAIL_TEXT'] ? JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown> : {}; }
		catch { /* parseTransferItem already reported this path */ }
		if (Array.isArray(detail['lines']) && detail['lines'].length !== parsed.lines.length) {
			invalidTransfers += 1;
			issues.push(issue('invalid_transfer_lines', String(parsed.id), 'one or more primary transfer lines failed validation'));
		}
		if (!parsed.lines.length) {
			invalidTransfers += 1;
			issues.push(issue('empty_transfer_lines', String(parsed.id), 'transfer has no valid primary lines'));
		}
		transfers.set(parsed.id, parsed);
		documents.push(transferDocument(item, parsed, observedAt));
	}

	const links: SupplyMirrorSourceLink[] = [];
	const allocations: SupplyMirrorSourceAllocation[] = [];
	const addLink = (from: MirrorDocumentRef, to: MirrorDocumentRef, relationType: SupplyMirrorSourceLink['relationType'], evidenceSource: string, payload: unknown): void => {
		links.push({ from, to, relationType, evidenceKind: 'explicit_external_field', evidenceSource, observedAt, sourcePayload: payload });
	};
	const index = byItem(documents);

	for (const order of raw.purchaseOrders) {
		const orderRef = docRef('purchase_order', order['name']);
		const requestName = text(order[SUPPLY_REQUEST_FIELD]);
		if (!requestName) continue;
		const requestRef = docRef('supply_request', requestName);
		addLink(orderRef, requestRef, 'ordered_for_request', SUPPLY_REQUEST_FIELD, { order: order['name'], requestName, requestKey: order[SUPPLY_REQUEST_KEY_FIELD] });
		rawLines(order).forEach((line, lineIndex) => {
			const quantity = numberOrNull(line[SUPPLY_PURCHASE_REQUEST_QTY_FIELD]);
			const identity = `${text(order['name'])}:${lineIndex + 1}`;
			if (quantity === null || quantity <= 0) {
				issues.push(issue('missing_order_allocation_quantity', identity, `${SUPPLY_PURCHASE_REQUEST_QTY_FIELD} must be positive`));
				return;
			}
			const source = indexedLineRef(index, requestRef, text(line['item_code']), issues, identity);
			if (!source) return;
			allocations.push({ source, target: lineRef(orderRef, line, lineIndex), allocationType: 'ordered', quantity, evidenceKind: 'derived_match', evidenceSource: `${SUPPLY_PURCHASE_REQUEST_QTY_FIELD}+item_code`, observedAt, sourcePayload: line });
		});
	}

	for (const receipt of raw.purchaseReceipts) {
		const receiptRef = docRef('purchase_receipt', receipt['name']);
		const orderName = text(receipt[SUPPLY_PURCHASE_ORDER_FIELD]);
		const requestName = text(receipt[SUPPLY_REQUEST_FIELD]);
		if (orderName) addLink(receiptRef, docRef('purchase_order', orderName), 'received_against_order', SUPPLY_PURCHASE_ORDER_FIELD, receipt);
		if (requestName) addLink(receiptRef, docRef('supply_request', requestName), 'received_for_request', SUPPLY_REQUEST_FIELD, receipt);
		if (!orderName) {
			issues.push(issue('missing_receipt_order', text(receipt['name']), `missing ${SUPPLY_PURCHASE_ORDER_FIELD}`));
			continue;
		}
		const orderRef = docRef('purchase_order', orderName);
		rawLines(receipt).forEach((line, lineIndex) => {
			const source = indexedLineRef(index, orderRef, text(line['item_code']), issues, `${text(receipt['name'])}:${lineIndex + 1}`);
			const quantity = Number(line['qty']);
			if (source && Number.isFinite(quantity) && quantity > 0) allocations.push({ source, target: lineRef(receiptRef, line, lineIndex), allocationType: 'received', quantity, evidenceKind: 'explicit_external_field', evidenceSource: `${SUPPLY_PURCHASE_ORDER_FIELD}+item_code`, observedAt, sourcePayload: line });
		});
	}

	for (const transfer of transfers.values()) {
		const transferRef = docRef('transfer', transfer.id, 'bitrix');
		const basis = transfer.purchaseOrder ? docRef('purchase_order', transfer.purchaseOrder) : transfer.supplyRequest ? docRef('supply_request', transfer.supplyRequest) : null;
		if (transfer.supplyRequest) addLink(transferRef, docRef('supply_request', transfer.supplyRequest), 'transfers_for_request', 'DETAIL_TEXT.supplyRequest', transfer);
		if (transfer.purchaseOrder) addLink(transferRef, docRef('purchase_order', transfer.purchaseOrder), 'transfers_for_purchase', 'DETAIL_TEXT.purchaseOrder', transfer);
		if (!basis) issues.push(issue('missing_transfer_basis', String(transfer.id), 'transfer has neither purchaseOrder nor supplyRequest'));
		if (transfer.correctionOf) addLink(transferRef, docRef('transfer', transfer.correctionOf, 'bitrix'), 'corrects_transfer', 'DETAIL_TEXT.correctionOf', transfer);
		if (basis) transfer.lines.forEach((line, lineIndex) => {
			const source = indexedLineRef(index, basis, String(line.productId), issues, `${transfer.id}:${lineIndex + 1}`);
			if (source && line.qty > 0) allocations.push({ source, target: { document: transferRef, lineOrdinal: lineIndex + 1 }, allocationType: 'transferred', quantity: line.qty, evidenceKind: 'derived_match', evidenceSource: 'explicit_document_ref+productId', observedAt, sourcePayload: line });
		});
	}

	const phaseRelation: Record<string, SupplyMirrorSourceLink['relationType']> = {
		ship: 'posts_transfer_ship', legacy_receive: 'posts_transfer_receive', receive: 'posts_transfer_receive',
		correction_return: 'posts_transfer_correction', correction_extra: 'posts_transfer_correction',
	};
	for (const entry of raw.stockEntries) {
		const transferId = text(entry[TRANSFER_DOCUMENT_FIELD]);
		const phase = text(entry[TRANSFER_PHASE_FIELD]);
		const relation = phaseRelation[phase];
		const entryRef = docRef('stock_entry', entry['name']);
		const transferRef = docRef('transfer', transferId, 'bitrix');
		if (!transferId || !relation) {
			issues.push(issue('invalid_stock_entry_transfer_ref', text(entry['name']), `transfer=${transferId || '(empty)'}, phase=${phase || '(empty)'}`));
			continue;
		}
		addLink(entryRef, transferRef, relation, `${TRANSFER_DOCUMENT_FIELD}+${TRANSFER_PHASE_FIELD}`, entry);
		rawLines(entry).forEach((line, lineIndex) => {
			const source = indexedLineRef(index, transferRef, text(line['item_code']), issues, `${text(entry['name'])}:${lineIndex + 1}`);
			const quantity = Number(line['qty']);
			if (source && Number.isFinite(quantity) && quantity > 0) allocations.push({ source, target: lineRef(entryRef, line, lineIndex), allocationType: phase === 'ship' ? 'transferred' : 'fulfilled', quantity, evidenceKind: 'explicit_external_field', evidenceSource: `${TRANSFER_DOCUMENT_FIELD}+${TRANSFER_PHASE_FIELD}+item_code`, observedAt, sourcePayload: line });
		});
	}

	return {
		observedAt,
		sources: {
			erpnext: { complete: true, records: raw.materialRequests.length + raw.purchaseOrders.length + raw.purchaseReceipts.length + raw.stockEntries.length },
			bitrixTransfers: invalidTransfers
				? { complete: false, records: raw.transferItems.length, error: `${invalidTransfers} invalid transfer records` }
				: { complete: true, records: raw.transferItems.length },
		},
		documents,
		links,
		allocations,
		discoveryIssues: issues,
	};
}

export const SUPPLY_BACKFILL_AUDITED_FIELDS = {
	deal: DEAL_FIELD,
	request: SUPPLY_REQUEST_FIELD,
	requestKey: SUPPLY_REQUEST_KEY_FIELD,
	purchaseOrder: SUPPLY_PURCHASE_ORDER_FIELD,
	requestQuantity: SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	purchaseStage: SUPPLY_PURCHASE_STAGE_FIELD,
	orderedAt: SUPPLY_PURCHASE_ORDERED_AT_FIELD,
	expectedAt: SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
	transferDocument: TRANSFER_DOCUMENT_FIELD,
	transferPhase: TRANSFER_PHASE_FIELD,
} as const;
