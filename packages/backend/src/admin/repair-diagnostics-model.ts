import { CLIENT_ORDER, PRESALE_ORDER } from '../routes/repair-status.js';
import type { RepairData } from '../routes/repair-record.js';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export interface DiagnosticIssue { code: string; severity: DiagnosticSeverity; title: string; details: string }
export interface DiagnosticExternalState {
	stockLocation: string | null;
	stockError: string | null;
	dealFound: boolean | null;
	dealClosed: boolean | null;
	dealSemantic: string | null;
	taskFound: boolean | null;
	taskCompleted: boolean | null;
	deliveryNoteStatus: number | null;
}

const OFFICE_STORE = 'Измайловский 18Д';
const TRANSIT_STORE = 'Goods In Transit';

export function expectedRepairStore(data: RepairData): string | null {
	if (data.kind === 'presale') {
		return data.status === 'pre_office' || data.status === 'pre_back_office' ? OFFICE_STORE
			: data.status === 'pre_sent' || data.status === 'pre_to_point' ? TRANSIT_STORE
				: data.status === 'pre_at_tt' ? data.issueStore
					: null;
	}
	return data.status === 'received_tt' ? data.point
		: data.status === 'received_office' ? OFFICE_STORE
			: data.status === 'sent' || data.status === 'sent_to_tt' ? TRANSIT_STORE
				: data.status === 'ready_tt' ? data.issueStore
					: null;
}

function statusJumpIssues(data: RepairData): DiagnosticIssue[] {
	const order = data.kind === 'presale' ? PRESALE_ORDER : CLIENT_ORDER;
	const statuses = (data.history ?? []).filter((row) => !row.note).map((row) => row.status);
	const issues: DiagnosticIssue[] = [];
	for (let index = 1; index < statuses.length; index++) {
		const before = order.indexOf(statuses[index - 1]!);
		const after = order.indexOf(statuses[index]!);
		if (before >= 0 && after >= 0 && Math.abs(after - before) > 1) {
			issues.push({
				code: `status_jump_${index}`,
				severity: 'warning',
				title: 'Статусы были перескочены',
				details: `${statuses[index - 1]} → ${statuses[index]}`,
			});
		}
	}
	return issues;
}

export function diagnoseRepairState(data: RepairData, external: DiagnosticExternalState): DiagnosticIssue[] {
	const issues = statusJumpIssues(data);
	const expectedStore = expectedRepairStore(data);
	const finished = data.kind === 'presale' ? data.status === 'pre_at_tt' : data.status === 'issued';
	if (external.stockError) {
		issues.push({ code: 'stock_read_error', severity: 'error', title: 'Не удалось определить остаток', details: external.stockError });
	} else if (data.kind === 'client' && !data.repairItemCode) {
		issues.push({ code: 'missing_item_code', severity: 'error', title: 'Нет складской карточки аппарата', details: `Ожидался код REPAIR-${data.repairNo}` });
	} else if (data.kind === 'client' && finished && external.stockLocation) {
		issues.push({ code: 'issued_with_stock', severity: 'error', title: 'Выданный аппарат остался на складе', details: external.stockLocation });
	} else if (data.kind === 'client' && !finished && !external.stockLocation) {
		issues.push({ code: 'active_without_stock', severity: 'error', title: 'Аппарат отсутствует на складах', details: 'Ремонт ещё не выдан, но остаток не найден.' });
	} else if (expectedStore && external.stockLocation && expectedStore !== external.stockLocation) {
		issues.push({ code: 'wrong_store', severity: 'warning', title: 'Статус не совпадает с фактическим складом', details: `По статусу: ${expectedStore}; фактически: ${external.stockLocation}` });
	}
	if (data.repairStore && external.stockLocation && data.repairStore !== external.stockLocation) {
		issues.push({ code: 'stale_stored_location', severity: 'warning', title: 'В карточке сохранён устаревший склад', details: `Карточка: ${data.repairStore}; фактически: ${external.stockLocation}` });
	}
	if (data.kind === 'client' && data.dealId && external.dealFound === false) {
		issues.push({ code: 'missing_deal', severity: 'error', title: 'Связанная сделка не найдена', details: `Сделка #${data.dealId}` });
	}
	if (data.clientRefusal && external.dealFound && (external.dealClosed === false || (external.dealSemantic !== null && external.dealSemantic !== 'F'))) {
		issues.push({ code: 'refused_deal_open', severity: 'error', title: 'Сделка отказного ремонта не закрыта как проигранная', details: `Сделка #${data.dealId ?? '—'}` });
	}
	if (data.taskId && external.taskFound === false) {
		issues.push({ code: 'missing_task', severity: 'warning', title: 'Связанная задача не найдена', details: `Задача #${data.taskId}` });
	}
	if (data.clientRefusal && data.status !== 'issued' && external.taskCompleted === true) {
		issues.push({ code: 'return_task_closed_early', severity: 'warning', title: 'Задача возврата закрыта до выдачи аппарата', details: `Задача #${data.taskId ?? '—'}` });
	}
	if (data.clientRefusal && data.status === 'issued' && data.taskId && external.taskCompleted === false) {
		issues.push({ code: 'return_task_still_open', severity: 'warning', title: 'Аппарат выдан, но задача возврата открыта', details: `Задача #${data.taskId}` });
	}
	if (data.kind === 'client' && data.status === 'issued' && external.deliveryNoteStatus !== 1) {
		issues.push({ code: 'missing_submitted_delivery', severity: 'error', title: 'Нет проведённого документа выдачи', details: data.repairDeliveryNote || 'Номер документа в карточке отсутствует.' });
	}
	if (data.clientRefusal && (!data.clientRefusal.dealCancelled || !data.clientRefusal.taskReframed)) {
		issues.push({ code: 'refusal_incomplete', severity: 'warning', title: 'Отказ оформлен не полностью', details: 'Не завершена отмена сделки или обновление задачи.' });
	}
	return issues;
}
