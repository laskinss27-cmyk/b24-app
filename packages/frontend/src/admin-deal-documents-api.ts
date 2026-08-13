import { bx24Auth } from './bitrix-auth.js';

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
	type: 'Sales Order' | 'Delivery Note' | 'Material Request' | 'Purchase Order' | 'Purchase Receipt' | 'Stock Entry';
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

export interface AdminDealApplicationDocuments {
	contracts: Array<{ id: string; contractNumber: string; templateTitle: string; companyName: string; customerName: string; contractDate: string; createdAt: string; filename: string; total: number }>;
	supplyCards: Array<{ id: number; title: string; stageId: string }>;
	transfers: Array<{
		id: number; name: string; status: string; fromStore: string; toStore: string; createdAt: string; createdByName: string;
		supplyRequest: string; supplyRequestKey: string; purchaseOrder: string; shipEntry: string; receiveEntry: string; note: string;
		items: Array<{ productId: number; itemName: string; qty: number }>; historyCount: number;
	}>;
	errors: Array<{ source: 'contracts' | 'supply' | 'transfers'; message: string }>;
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
	structure: {
		status: 'ok' | 'warning' | 'error';
		checkedLinkCount: number;
		brokenLinkCount: number;
		links: Array<{
			fromType: string; fromName: string; relation: string;
			targetType: AdminDealDocument['type']; targetName: string;
			status: 'linked' | 'wrong_deal' | 'missing' | 'unreadable';
			targetDealId: number | null; targetDocstatus: number | null; details: string;
		}>;
	};
	calculatedFulfillment: 'ДА' | 'НЕТ';
	shortages: Array<{ productId: number; itemName: string; required: number; realized: number }>;
	issues: Array<{ code: string; severity: 'info' | 'warning' | 'error'; title: string; details: string }>;
}

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...body }),
	});
	const json = await response.json() as { ok?: boolean; error?: string } & T;
	if (!response.ok || !json.ok) throw new Error(json.error ?? 'Ошибка диагностики документов сделки.');
	return json;
}

export async function searchAdminDealDocuments(query: string): Promise<AdminDealDocumentSummary[]> {
	const result = await post<{ deals?: AdminDealDocumentSummary[] }>('/api/admin/deal-documents/search', { query, limit: 30 });
	return result.deals ?? [];
}

export async function diagnoseAdminDealDocuments(dealId: number): Promise<AdminDealDocumentDiagnostic> {
	const result = await post<{ diagnostic?: AdminDealDocumentDiagnostic }>('/api/admin/deal-documents/diagnose', { dealId });
	if (!result.diagnostic) throw new Error('Сервер не вернул результат диагностики документов сделки.');
	return result.diagnostic;
}

export async function restoreAdminDealDocumentLink(input: {
	dealId: number;
	targetType: AdminDealDocument['type'];
	targetName: string;
	comment: string;
}): Promise<{ changed: boolean }> {
	const result = await post<{ result?: { changed?: boolean } }>('/api/admin/deal-documents/restore-link', input);
	if (!result.result) throw new Error('Сервер не подтвердил восстановление связи документа.');
	return { changed: Boolean(result.result.changed) };
}
