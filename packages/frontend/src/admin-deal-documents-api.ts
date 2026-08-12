import { bx24Auth } from './bitrix-auth.js';

export interface AdminDealDocumentSummary {
	dealId: number;
	planCount: number;
	realizationCount: number;
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
	type: 'Sales Order' | 'Delivery Note';
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
