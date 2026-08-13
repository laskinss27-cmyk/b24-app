import type { B24Client } from '../b24/client.js';
import { calculateDealFulfillment, DEAL_FULFILLMENT_FIELD, type DealFulfillmentValue } from '../deal-fulfillment.js';
import type { ErpClient } from '../erp/client.js';
import type { ErpRealization } from '../erp/deal-realizations.js';
import { DEAL_FIELD } from '../erp/erp-setup.js';
import type { PlanItem } from '../erp/deal-plan-state.js';
import type { DiagnosticIssue } from './repair-diagnostics-model.js';
import { readDealApplicationDocuments, type AdminDealApplicationDocuments } from './deal-application-documents.js';
import { inspectDealDocumentStructure, type DealDocumentStructureReport } from './deal-document-structure.js';

type DealDocumentType = 'Sales Order' | 'Delivery Note' | 'Material Request' | 'Purchase Order' | 'Purchase Receipt' | 'Stock Entry';

interface DocumentSpec {
	type: DealDocumentType;
	label: string;
}

const DOCUMENT_SPECS: DocumentSpec[] = [
	{ type: 'Sales Order', label: 'План сделки' },
	{ type: 'Delivery Note', label: 'Реализация' },
	{ type: 'Material Request', label: 'Заявка снабжению' },
	{ type: 'Purchase Order', label: 'Заказ поставщику' },
	{ type: 'Purchase Receipt', label: 'Приход от поставщика' },
	{ type: 'Stock Entry', label: 'Складское перемещение' },
];

export interface AdminDealDocumentSummary {
	dealId: number;
	planCount: number;
	realizationCount: number;
	relatedCount: number;
	draftCount: number;
	lastDocument: string;
	lastModified: string;
}

export interface AdminDealDocumentItem {
	rowName: string;
	productId: number | null;
	itemCode: string;
	itemName: string;
	qty: number;
	deliveredQty: number | null;
	rate: number;
	amount: number;
	warehouse: string;
	targetWarehouse: string;
	againstSalesOrder: string;
}

export interface AdminDealDocument {
	type: DealDocumentType;
	label: string;
	name: string;
	docstatus: number;
	status: string;
	isReturn: boolean;
	returnAgainst: string;
	amendedFrom: string;
	postingDate: string;
	creation: string;
	modified: string;
	total: number;
	supplier: string;
	supplyRequest: string;
	purchaseOrder: string;
	stockEntryType: string;
	note: string;
	items: AdminDealDocumentItem[];
}

export interface AdminDealDocumentDiagnostic {
	deal: {
		id: number;
		found: boolean | null;
		title: string;
		categoryId: number | null;
		stageId: string;
		closed: boolean | null;
		semantic: string | null;
		opportunity: number | null;
		fulfillmentField: string;
		error: string | null;
	};
	documents: AdminDealDocument[];
	applicationDocuments: AdminDealApplicationDocuments;
	structure: DealDocumentStructureReport;
	calculatedFulfillment: DealFulfillmentValue;
	shortages: Array<{ productId: number; itemName: string; required: number; realized: number }>;
	issues: DiagnosticIssue[];
}

interface DocumentHead {
	type: DealDocumentType;
	name: string;
	dealId: number;
	docstatus: number;
	modified: string;
}

function numericDealId(query: string): number | null {
	const match = query.trim().match(/^#?(\d+)$/);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isInteger(value) && value > 0 ? value : null;
}

function asHead(type: DealDocumentType, row: Record<string, unknown>): DocumentHead | null {
	const dealId = Number(row[DEAL_FIELD]);
	const name = String(row['name'] ?? '').trim();
	if (!Number.isInteger(dealId) || dealId <= 0 || !name) return null;
	return { type, name, dealId, docstatus: Number(row['docstatus'] ?? 0), modified: String(row['modified'] ?? '') };
}

async function listHeads(erp: ErpClient, spec: DocumentSpec, filters: unknown[], limit: number): Promise<DocumentHead[]> {
	const rows = await erp.list<Record<string, unknown>>(
		spec.type,
		['name', DEAL_FIELD, 'docstatus', 'modified'],
		filters,
		limit,
		'modified desc',
	);
	return rows.flatMap((row) => {
		const head = asHead(spec.type, row);
		return head ? [head] : [];
	});
}

export async function searchAdminDealDocuments(erp: ErpClient, query: string, limit = 30): Promise<AdminDealDocumentSummary[]> {
	const safeLimit = Math.max(1, Math.min(100, limit));
	const cleanQuery = query.trim().slice(0, 120);
	const directDealId = numericDealId(cleanQuery);
	const filters = directDealId
		? [[DEAL_FIELD, '=', String(directDealId)]]
		: cleanQuery
			? [['name', 'like', `%${cleanQuery}%`]]
			: [[DEAL_FIELD, '!=', '']];
	const heads = (await Promise.all(DOCUMENT_SPECS.map((spec) => listHeads(erp, spec, filters, safeLimit)))).flat();
	const byDeal = new Map<number, DocumentHead[]>();
	for (const head of heads) byDeal.set(head.dealId, [...(byDeal.get(head.dealId) ?? []), head]);
	if (directDealId && !byDeal.has(directDealId)) byDeal.set(directDealId, []);
	return [...byDeal.entries()]
		.map(([dealId, documents]) => {
			const recent = [...documents].sort((left, right) => right.modified.localeCompare(left.modified))[0];
			return {
				dealId,
				planCount: documents.filter((document) => document.type === 'Sales Order').length,
				realizationCount: documents.filter((document) => document.type === 'Delivery Note').length,
				relatedCount: documents.filter((document) => document.type !== 'Sales Order' && document.type !== 'Delivery Note').length,
				draftCount: documents.filter((document) => document.type === 'Delivery Note' && document.docstatus === 0).length,
				lastDocument: recent?.name ?? '',
				lastModified: recent?.modified ?? '',
			};
		})
		.sort((left, right) => right.lastModified.localeCompare(left.lastModified) || right.dealId - left.dealId)
		.slice(0, safeLimit);
}

export async function dealIdsModifiedInPeriod(erp: ErpClient, dateFrom: string, dateTo: string): Promise<number[]> {
	const filters = [
		['modified', '>=', `${dateFrom} 00:00:00`],
		['modified', '<=', `${dateTo} 23:59:59.999999`],
		[DEAL_FIELD, '!=', ''],
	];
	const heads = (await Promise.all(DOCUMENT_SPECS.map((spec) => listHeads(erp, spec, filters, 0)))).flat();
	const latestByDeal = new Map<number, string>();
	for (const head of heads) {
		const current = latestByDeal.get(head.dealId) ?? '';
		if (head.modified > current) latestByDeal.set(head.dealId, head.modified);
	}
	return [...latestByDeal.entries()]
		.sort((left, right) => right[1].localeCompare(left[1]) || right[0] - left[0])
		.map(([dealId]) => dealId);
}

function shortWarehouse(value: unknown): string {
	return String(value ?? '').replace(/\s+-\s+[^-]+$/, '');
}

function normalizeItem(row: Record<string, unknown>): AdminDealDocumentItem {
	const itemCode = String(row['item_code'] ?? '').trim();
	const numericProductId = Number(itemCode);
	return {
		rowName: String(row['name'] ?? ''),
		productId: Number.isInteger(numericProductId) && numericProductId > 0 ? numericProductId : null,
		itemCode,
		itemName: String(row['item_name'] ?? ''),
		qty: Number(row['qty'] ?? 0),
		deliveredQty: row['delivered_qty'] === undefined || row['delivered_qty'] === null ? null : Number(row['delivered_qty']),
		rate: Number(row['rate'] ?? 0),
		amount: Number(row['amount'] ?? 0),
		warehouse: shortWarehouse(row['warehouse'] ?? row['s_warehouse']),
		targetWarehouse: shortWarehouse(row['target_warehouse'] ?? row['t_warehouse']),
		againstSalesOrder: String(row['against_sales_order'] ?? ''),
	};
}

function normalizeDocument(spec: DocumentSpec, raw: Record<string, unknown>): AdminDealDocument {
	const isReturn = spec.type === 'Delivery Note' && Number(raw['is_return'] ?? 0) === 1;
	return {
		type: spec.type,
		label: isReturn ? 'Возврат клиента' : spec.label,
		name: String(raw['name'] ?? ''),
		docstatus: Number(raw['docstatus'] ?? 0),
		status: String(raw['status'] ?? ''),
		isReturn,
		returnAgainst: String(raw['return_against'] ?? ''),
		amendedFrom: String(raw['amended_from'] ?? ''),
		postingDate: String(raw['posting_date'] ?? raw['transaction_date'] ?? ''),
		creation: String(raw['creation'] ?? ''),
		modified: String(raw['modified'] ?? ''),
		total: Number(raw['grand_total'] ?? 0),
		supplier: String(raw['supplier'] ?? ''),
		supplyRequest: String(raw['b24_supply_request'] ?? ''),
		purchaseOrder: String(raw['b24_purchase_order'] ?? ''),
		stockEntryType: String(raw['stock_entry_type'] ?? ''),
		note: String(raw['b24_note'] ?? raw['remarks'] ?? ''),
		items: (Array.isArray(raw['items']) ? raw['items'] : []).map((row) => normalizeItem(row as Record<string, unknown>)),
	};
}

async function readDocuments(erp: ErpClient, dealId: number): Promise<AdminDealDocument[]> {
	const groups = await Promise.all(DOCUMENT_SPECS.map(async (spec) => {
		const heads = await erp.list<Record<string, unknown>>(spec.type, ['name'], [[DEAL_FIELD, '=', String(dealId)]], 100, 'creation asc');
		const documents = await Promise.all(heads.map((head) => erp.get<Record<string, unknown>>(spec.type, String(head['name'] ?? ''))));
		return documents.flatMap((document) => document ? [normalizeDocument(spec, document)] : []);
	}));
	return groups.flat().sort((left, right) => `${left.postingDate}|${left.creation}`.localeCompare(`${right.postingDate}|${right.creation}`));
}

function planItems(document: AdminDealDocument | undefined): PlanItem[] {
	return document?.items.flatMap((item) => item.productId === null ? [] : [{
		productId: item.productId,
		itemName: item.itemName,
		qty: item.qty,
		rate: item.rate,
		priceListRate: item.rate,
		discountPercent: 0,
		delivered: item.deliveredQty ?? 0,
		isService: !item.warehouse,
		lineKey: item.rowName,
	}]) ?? [];
}

function realizations(documents: AdminDealDocument[], dealId: number): ErpRealization[] {
	return documents
		.filter((document) => document.type === 'Delivery Note' && document.docstatus !== 2)
		.map((document) => ({
			name: document.name,
			dealId: String(dealId),
			postingDate: document.postingDate,
			submitted: document.docstatus === 1,
			isReturn: document.isReturn,
			returnAgainst: document.returnAgainst,
			grandTotal: document.total,
			items: document.items.flatMap((item) => item.productId === null ? [] : [{
				productId: item.productId,
				itemName: item.itemName,
				qty: item.qty,
				storeTitle: item.warehouse,
				rate: item.rate,
				rowName: item.rowName,
				sourceRow: '',
				segmentId: '',
			}]),
		}));
}

function fulfillmentShortages(plan: PlanItem[], documents: ErpRealization[]): AdminDealDocumentDiagnostic['shortages'] {
	const realized = new Map<number, number>();
	for (const document of documents.filter((item) => item.submitted)) {
		for (const item of document.items) realized.set(item.productId, (realized.get(item.productId) ?? 0) + item.qty);
	}
	return plan.flatMap((item) => {
		const shipped = realized.get(item.productId) ?? 0;
		return shipped + 0.000001 >= item.qty ? [] : [{ productId: item.productId, itemName: item.itemName, required: item.qty, realized: shipped }];
	});
}

function dealError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function diagnoseAdminDealDocuments(client: B24Client, erp: ErpClient, dealId: number): Promise<AdminDealDocumentDiagnostic> {
	const [documents, applicationDocuments] = await Promise.all([
		readDocuments(erp, dealId),
		readDealApplicationDocuments(client, dealId),
	]);
	const structureInspection = await inspectDealDocumentStructure(erp, dealId, documents, applicationDocuments);
	let rawDeal: Record<string, unknown> | null = null;
	let readError: string | null = null;
	try {
		rawDeal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	} catch (error) {
		readError = dealError(error);
	}
	const activePlans = documents.filter((document) => document.type === 'Sales Order' && document.docstatus === 0);
	const activePlan = activePlans.at(-1);
	const currentPlan = planItems(activePlan);
	const dealRealizations = realizations(documents, dealId);
	const calculatedFulfillment = calculateDealFulfillment(currentPlan, dealRealizations);
	const shortages = fulfillmentShortages(currentPlan, dealRealizations);
	const fulfillmentField = String(rawDeal?.[DEAL_FULFILLMENT_FIELD] ?? '').trim().toLocaleUpperCase('ru-RU');
	const issues: DiagnosticIssue[] = [...structureInspection.issues];
	if (!rawDeal) issues.push({ code: 'deal_read_error', severity: 'error', title: 'Не удалось прочитать сделку', details: readError ?? 'Битрикс24 не вернул карточку сделки.' });
	if (!activePlan) issues.push({ code: 'missing_plan', severity: 'warning', title: 'Нет действующего плана сделки', details: 'В ядре не найден черновик Sales Order, который является текущим составом сделки.' });
	if (activePlans.length > 1) issues.push({ code: 'multiple_plans', severity: 'warning', title: 'Несколько действующих планов', details: `Найдено черновиков Sales Order: ${activePlans.length}. Приложение использует самый новый.` });
	const drafts = documents.filter((document) => document.type === 'Delivery Note' && document.docstatus === 0);
	if (drafts.length) issues.push({ code: 'realization_drafts', severity: 'warning', title: 'Есть непроведённые реализации', details: drafts.map((document) => document.name).join(', ') });
	if (shortages.length) issues.push({ code: 'not_fully_realized', severity: 'warning', title: 'Не все позиции проведены', details: shortages.map((item) => `${item.itemName || `#${item.productId}`}: ${item.realized} из ${item.required}`).join('; ') });
	if (fulfillmentField && fulfillmentField !== calculatedFulfillment) issues.push({ code: 'fulfillment_mismatch', severity: 'error', title: 'Техническое поле сделки не совпадает с ядром', details: `В Битрикс24: «${fulfillmentField}», по документам ядра: «${calculatedFulfillment}».` });
	for (const error of applicationDocuments.errors) issues.push({
		code: `application_documents_${error.source}`,
		severity: 'warning',
		title: 'Часть документов приложения недоступна',
		details: `${error.source}: ${error.message}`,
	});
	return {
		deal: {
			id: dealId,
			found: rawDeal ? true : readError ? null : false,
			title: String(rawDeal?.['TITLE'] ?? ''),
			categoryId: Number.isFinite(Number(rawDeal?.['CATEGORY_ID'])) ? Number(rawDeal?.['CATEGORY_ID']) : null,
			stageId: String(rawDeal?.['STAGE_ID'] ?? ''),
			closed: rawDeal ? String(rawDeal['CLOSED'] ?? '').toUpperCase() === 'Y' : null,
			semantic: String(rawDeal?.['STAGE_SEMANTIC_ID'] ?? '').toUpperCase() || null,
			opportunity: Number.isFinite(Number(rawDeal?.['OPPORTUNITY'])) ? Number(rawDeal?.['OPPORTUNITY']) : null,
			fulfillmentField,
			error: readError,
		},
		documents,
		applicationDocuments,
		structure: structureInspection.report,
		calculatedFulfillment,
		shortages,
		issues,
	};
}
