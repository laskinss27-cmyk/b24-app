import type { RepairKind, RepairStatus } from './b24.js';

export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
	received_tt: 'Принято на ТТ',
	received_office: 'Принято в офисе',
	sent: 'Отправлено в ремонт',
	sent_to_tt: 'Отправлено на ТТ',
	ready_tt: 'Готово к выдаче',
	issued: 'Выдано',
	// предпродажный
	pre_office: 'Принято в офисе',
	pre_sent: 'Отправлено в ремонт',
	pre_back_office: 'Принято с ремонта в офис',
	pre_to_point: 'Отправлено на точку',
	pre_at_tt: 'Принято на ТТ',
};

export const CLIENT_REPAIR_STATUS_FLOW: RepairStatus[] = ['received_tt', 'received_office', 'sent', 'sent_to_tt', 'ready_tt', 'issued'];
const PRESALE_REPAIR_STATUS_FLOW: RepairStatus[] = ['pre_office', 'pre_sent', 'pre_back_office', 'pre_to_point', 'pre_at_tt'];

/** Цепочка статусов по потоку ремонта. */
export function repairStatusFlow(kind: RepairKind | undefined): RepairStatus[] {
	return kind === 'presale' ? PRESALE_REPAIR_STATUS_FLOW : CLIENT_REPAIR_STATUS_FLOW;
}

/** Со статуса «принято в офисе» клиентская карточка заморожена. Предпродажный ремонт не замораживаем. */
export function isRepairStatusLocked(status: RepairStatus): boolean {
	const lockedFromIndex = CLIENT_REPAIR_STATUS_FLOW.indexOf('received_office');
	const index = CLIENT_REPAIR_STATUS_FLOW.indexOf(status);
	return index >= 0 && index >= lockedFromIndex;
}
