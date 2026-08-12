import { B24ApiError, type B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { locateRepairUnit } from '../erp/repair-stock.js';
import type { RepairData } from '../routes/repair-record.js';

export interface DiagnosticDeal {
	id: number;
	found: boolean | null;
	title: string;
	categoryId: number | null;
	stageId: string;
	closed: boolean | null;
	semantic: string | null;
	opportunity: number | null;
	error: string | null;
}

export interface DiagnosticTask {
	id: number;
	found: boolean | null;
	title: string;
	status: string;
	completed: boolean | null;
	responsible: string;
	error: string | null;
}

export interface DiagnosticStockDocument {
	type: 'Purchase Receipt' | 'Stock Entry' | 'Delivery Note';
	name: string;
	docstatus: number;
	postingDate: string;
	creation: string;
	qty: number;
	fromStore: string;
	toStore: string;
	dealId: string;
}

export interface DiagnosticErpState {
	itemCode: string | null;
	stockLocation: string | null;
	stockQty: number | null;
	stockError: string | null;
	deliveryNoteStatus: number | null;
	documents: DiagnosticStockDocument[];
	documentsError: string | null;
	preciseStockSupported: boolean;
}

function b24Error(error: unknown): string {
	return error instanceof B24ApiError
		? `${error.code}${error.description ? `: ${error.description}` : ''}`
		: error instanceof Error ? error.message : String(error);
}

function b24Missing(error: unknown): boolean {
	return error instanceof B24ApiError && /NOT_FOUND|NOT EXIST/i.test(`${error.code} ${error.description ?? ''}`);
}

export async function readDiagnosticDeal(client: B24Client, dealId: number | null): Promise<DiagnosticDeal | null> {
	if (!dealId) return null;
	try {
		const raw = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
		return {
			id: dealId,
			found: true,
			title: String(raw['TITLE'] ?? ''),
			categoryId: Number.isFinite(Number(raw['CATEGORY_ID'])) ? Number(raw['CATEGORY_ID']) : null,
			stageId: String(raw['STAGE_ID'] ?? ''),
			closed: String(raw['CLOSED'] ?? '').toUpperCase() === 'Y',
			semantic: String(raw['STAGE_SEMANTIC_ID'] ?? raw['SEMANTIC_ID'] ?? '').toUpperCase() || null,
			opportunity: Number.isFinite(Number(raw['OPPORTUNITY'])) ? Number(raw['OPPORTUNITY']) : null,
			error: null,
		};
	} catch (error) {
		return { id: dealId, found: b24Missing(error) ? false : null, title: '', categoryId: null, stageId: '', closed: null, semantic: null, opportunity: null, error: b24Error(error) };
	}
}

export async function readDiagnosticTask(client: B24Client, taskId: number | null): Promise<DiagnosticTask | null> {
	if (!taskId) return null;
	try {
		const result = await client.call<{ task?: Record<string, unknown> }>('tasks.task.get', {
			taskId,
			select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'RESPONSIBLE_NAME', 'RESPONSIBLE_LAST_NAME'],
		});
		const raw = result?.task ?? {};
		const status = String(raw['status'] ?? raw['STATUS'] ?? '');
		const responsible = `${raw['responsibleLastName'] ?? raw['RESPONSIBLE_LAST_NAME'] ?? ''} ${raw['responsibleName'] ?? raw['RESPONSIBLE_NAME'] ?? ''}`.trim();
		return { id: taskId, found: true, title: String(raw['title'] ?? raw['TITLE'] ?? ''), status, completed: status === '5', responsible, error: null };
	} catch (error) {
		return { id: taskId, found: b24Missing(error) ? false : null, title: '', status: '', completed: null, responsible: '', error: b24Error(error) };
	}
}

interface ChildDocumentSpec {
	type: DiagnosticStockDocument['type'];
	childType: string;
}

const DOCUMENT_SPECS: ChildDocumentSpec[] = [
	{ type: 'Purchase Receipt', childType: 'Purchase Receipt Item' },
	{ type: 'Stock Entry', childType: 'Stock Entry Detail' },
	{ type: 'Delivery Note', childType: 'Delivery Note Item' },
];

function shortWarehouse(value: unknown): string {
	return String(value ?? '').replace(/\s+-\s+[^-]+$/, '');
}

export async function readRepairStockDocuments(erp: ErpClient, itemCode: string): Promise<DiagnosticStockDocument[]> {
	const documents: DiagnosticStockDocument[] = [];
	const seen = new Set<string>();
	for (const spec of DOCUMENT_SPECS) {
		// Frappe list для дочерних таблиц фактически возвращает только `name`, даже если запросить parent/qty/warehouse.
		// Поэтому каждую найденную строку читаем отдельно — так же, как рабочая логика выдачи ремонта.
		const childHeads = await erp.list<Record<string, unknown>>(spec.childType, ['name'], [['item_code', '=', itemCode]]);
		for (const childHead of childHeads) {
			const childName = String(childHead['name'] ?? '');
			const child = childName ? await erp.get<Record<string, unknown>>(spec.childType, childName) : null;
			if (!child) continue;
			const name = String(child['parent'] ?? '');
			if (!name) continue;
			const documentKey = `${spec.type}:${name}`;
			if (seen.has(documentKey)) continue;
			const parent = await erp.get<Record<string, unknown>>(spec.type, name);
			if (!parent) continue;
			seen.add(documentKey);
			documents.push({
				type: spec.type,
				name,
				docstatus: Number(parent['docstatus'] ?? 0),
				postingDate: `${parent['posting_date'] ?? ''} ${parent['posting_time'] ?? ''}`.trim(),
				creation: String(parent['creation'] ?? ''),
				qty: Number(child['qty'] ?? 0),
				fromStore: shortWarehouse(spec.type === 'Delivery Note' ? child['warehouse'] : child['s_warehouse']),
				toStore: shortWarehouse(spec.type === 'Purchase Receipt' ? child['warehouse'] : child['t_warehouse']),
				dealId: String(parent['b24_deal_id'] ?? ''),
			});
		}
	}
	return documents.sort((left, right) => `${left.postingDate}|${left.creation}`.localeCompare(`${right.postingDate}|${right.creation}`));
}

export async function readDiagnosticErp(erp: ErpClient | null, data: RepairData): Promise<DiagnosticErpState> {
	if (!erp) {
		return { itemCode: data.repairItemCode, stockLocation: null, stockQty: null, stockError: 'Ядро склада не настроено.', deliveryNoteStatus: null, documents: [], documentsError: null, preciseStockSupported: data.kind === 'client' };
	}
	if (data.kind !== 'client') {
		return { itemCode: null, stockLocation: null, stockQty: null, stockError: null, deliveryNoteStatus: null, documents: [], documentsError: null, preciseStockSupported: false };
	}
	const itemCode = data.repairItemCode || (data.repairNo ? `REPAIR-${data.repairNo}` : null);
	let stockLocation: string | null = null;
	let stockQty: number | null = null;
	let stockError: string | null = null;
	let deliveryNoteStatus: number | null = null;
	let documents: DiagnosticStockDocument[] = [];
	let documentsError: string | null = null;
	if (itemCode) {
		try {
			const location = await locateRepairUnit(erp, itemCode);
			stockLocation = location?.storeTitle ?? null;
			stockQty = location?.qty ?? 0;
		} catch (error) {
			stockError = error instanceof Error ? error.message : String(error);
		}
		try {
			documents = await readRepairStockDocuments(erp, itemCode);
		} catch (error) {
			documentsError = error instanceof Error ? error.message : String(error);
		}
	}
	if (data.repairDeliveryNote) {
		try {
			const note = await erp.get<Record<string, unknown>>('Delivery Note', data.repairDeliveryNote);
			deliveryNoteStatus = note ? Number(note['docstatus'] ?? 0) : null;
		} catch (error) {
			documentsError = documentsError ?? (error instanceof Error ? error.message : String(error));
		}
	} else {
		const latest = [...documents].reverse().find((document) => document.type === 'Delivery Note');
		deliveryNoteStatus = latest?.docstatus ?? null;
	}
	return { itemCode, stockLocation, stockQty, stockError, deliveryNoteStatus, documents, documentsError, preciseStockSupported: true };
}
