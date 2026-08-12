import { bx24Auth } from './bitrix-auth.js';
import type { Repair, RepairKind, RepairStatus } from './repair-api.js';

export interface AdminRepairSummary {
	id: number;
	repairNo: number;
	kind: RepairKind;
	status: RepairStatus;
	clientName: string;
	device: string;
	model: string;
	serial: string;
	dealId: number | null;
	taskId: number | null;
	itemCode: string | null;
	refused: boolean;
}

export interface DiagnosticIssue {
	code: string;
	severity: 'info' | 'warning' | 'error';
	title: string;
	details: string;
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

export interface AdminRepairDiagnostic {
	repair: Repair;
	expectedStore: string | null;
	erp: {
		itemCode: string | null;
		stockLocation: string | null;
		stockQty: number | null;
		stockError: string | null;
		deliveryNoteStatus: number | null;
		documents: DiagnosticStockDocument[];
		documentsError: string | null;
		preciseStockSupported: boolean;
	};
	deal: null | { id: number; found: boolean | null; title: string; categoryId: number | null; stageId: string; closed: boolean | null; semantic: string | null; opportunity: number | null; error: string | null };
	task: null | { id: number; found: boolean | null; title: string; status: string; completed: boolean | null; responsible: string; error: string | null };
	issues: DiagnosticIssue[];
	rawRecord: Record<string, unknown>;
}

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...body }),
	});
	const json = await response.json() as { ok?: boolean; error?: string } & T;
	if (!response.ok || !json.ok) throw new Error(json.error ?? 'Ошибка диагностики.');
	return json;
}

export async function searchAdminRepairs(query: string): Promise<AdminRepairSummary[]> {
	const result = await post<{ repairs?: AdminRepairSummary[] }>('/api/admin/repairs/search', { query, limit: 30 });
	return result.repairs ?? [];
}

export async function diagnoseAdminRepair(repairId: number): Promise<AdminRepairDiagnostic> {
	const result = await post<{ diagnostic?: AdminRepairDiagnostic }>('/api/admin/repairs/diagnose', { repairId });
	if (!result.diagnostic) throw new Error('Сервер не вернул результат диагностики.');
	return result.diagnostic;
}
