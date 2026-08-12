import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { parseItem, type RepairData } from '../routes/repair-record.js';
import { fetchAllRepairs } from '../routes/repair-storage.js';
import { diagnoseRepairState, expectedRepairStore, type DiagnosticIssue } from './repair-diagnostics-model.js';
import { readDiagnosticDeal, readDiagnosticErp, readDiagnosticTask, type DiagnosticDeal, type DiagnosticErpState, type DiagnosticTask } from './repair-diagnostics-readers.js';

export interface AdminRepairSummary {
	id: number;
	repairNo: number;
	kind: RepairData['kind'];
	status: RepairData['status'];
	clientName: string;
	device: string;
	model: string;
	serial: string;
	dealId: number | null;
	taskId: number | null;
	itemCode: string | null;
	refused: boolean;
}

export interface AdminRepairDiagnostic {
	repair: RepairData & { id: number; name: string };
	expectedStore: string | null;
	erp: DiagnosticErpState;
	deal: DiagnosticDeal | null;
	task: DiagnosticTask | null;
	issues: DiagnosticIssue[];
	rawRecord: Record<string, unknown>;
}

function summary(repair: RepairData & { id: number }): AdminRepairSummary {
	return {
		id: repair.id,
		repairNo: repair.repairNo,
		kind: repair.kind,
		status: repair.status,
		clientName: repair.client.name,
		device: repair.device,
		model: repair.model,
		serial: repair.serial,
		dealId: repair.dealId,
		taskId: repair.taskId,
		itemCode: repair.repairItemCode,
		refused: Boolean(repair.clientRefusal),
	};
}

function searchable(repair: RepairData & { id: number; name: string }): string {
	return [repair.id, repair.repairNo, repair.name, repair.client.name, repair.client.phone, repair.device, repair.model,
		repair.serial, repair.dealId, repair.taskId, repair.repairItemCode, repair.repairDeliveryNote]
		.filter((value) => value !== null && value !== undefined)
		.join(' ')
		.toLocaleLowerCase('ru-RU');
}

function rawDetail(item: Record<string, unknown>): Record<string, unknown> {
	try {
		const parsed = JSON.parse(String(item['DETAIL_TEXT'] ?? '{}')) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return { parseError: 'DETAIL_TEXT содержит некорректный JSON', detailText: String(item['DETAIL_TEXT'] ?? '') };
	}
}

export async function searchAdminRepairs(client: B24Client, query: string, limit = 20): Promise<AdminRepairSummary[]> {
	const needle = query.trim().toLocaleLowerCase('ru-RU');
	return (await fetchAllRepairs(client))
		.map(parseItem)
		.filter((repair): repair is NonNullable<ReturnType<typeof parseItem>> => Boolean(repair))
		.filter((repair) => !needle || searchable(repair).includes(needle))
		.sort((left, right) => right.id - left.id)
		.slice(0, Math.max(1, Math.min(100, limit)))
		.map(summary);
}

export async function diagnoseAdminRepair(client: B24Client, erp: ErpClient | null, repairId: number): Promise<AdminRepairDiagnostic | null> {
	const item = (await fetchAllRepairs(client)).find((row) => Number(row['ID']) === repairId);
	if (!item) return null;
	const repair = parseItem(item);
	if (!repair) throw new Error('Карточка ремонта содержит повреждённые данные.');
	const [erpState, deal, task] = await Promise.all([
		readDiagnosticErp(erp, repair),
		readDiagnosticDeal(client, repair.dealId),
		readDiagnosticTask(client, repair.taskId),
	]);
	const issues = diagnoseRepairState(repair, {
		stockLocation: erpState.stockLocation,
		stockError: erpState.stockError,
		dealFound: deal?.found ?? null,
		dealClosed: deal?.closed ?? null,
		dealSemantic: deal?.semantic ?? null,
		taskFound: task?.found ?? null,
		taskCompleted: task?.completed ?? null,
		deliveryNoteStatus: erpState.deliveryNoteStatus,
	});
	if (deal?.error && deal.found !== false) issues.push({ code: 'deal_read_error', severity: 'warning', title: 'Не удалось полностью прочитать сделку', details: deal.error });
	if (task?.error && task.found !== false) issues.push({ code: 'task_read_error', severity: 'warning', title: 'Не удалось полностью прочитать задачу', details: task.error });
	if (erpState.documentsError) issues.push({ code: 'documents_read_error', severity: 'warning', title: 'Не удалось прочитать все складские документы', details: erpState.documentsError });
	return { repair, expectedStore: expectedRepairStore(repair), erp: erpState, deal, task, issues, rawRecord: rawDetail(item) };
}
