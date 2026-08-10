// Два потока ремонта (kind):
//  client  — клиентский RMA: принято на ТТ → в офисе → в ремонт → на ТТ → готово к выдаче → выдано.
//  presale — предпродажный (наш товар со склада): в офисе → в ремонт → с ремонта в офис → на точку → принято на ТТ.
export type RepairKind = 'client' | 'presale';
export type RepairStatus =
	| 'received_tt' | 'received_office' | 'sent' | 'sent_to_tt' | 'ready_tt' | 'issued'   // клиентский
	| 'pre_office' | 'pre_sent' | 'pre_back_office' | 'pre_to_point' | 'pre_at_tt';        // предпродажный
export const CLIENT_ORDER: RepairStatus[] = ['received_tt', 'received_office', 'sent', 'sent_to_tt', 'ready_tt', 'issued'];
export const PRESALE_ORDER: RepairStatus[] = ['pre_office', 'pre_sent', 'pre_back_office', 'pre_to_point', 'pre_at_tt'];
export const statusOrder = (kind: RepairKind): RepairStatus[] => kind === 'presale' ? PRESALE_ORDER : CLIENT_ORDER;

/** Со статуса «принято в офисе» КЛИЕНТСКАЯ карточка ЗАМОРОЖЕНА: правит только снабжение+ (canEditPrice).
 * Предпродажный не замораживаем (нет цен/клиента) — isLocked для его статусов вернёт false. */
const LOCK_FROM_INDEX = CLIENT_ORDER.indexOf('received_office');
export function isLocked(s: RepairStatus): boolean {
	const i = CLIENT_ORDER.indexOf(s);
	return i >= 0 && i >= LOCK_FROM_INDEX;
}

/** Маппинг старых статусов (до разделения приёма ТТ/офис) на новые — чтобы прежние карточки не сломались. */
const LEGACY_STATUS: Record<string, RepairStatus> = {
	received: 'received_tt',
	sent: 'sent',
	returned: 'ready_tt',
	issued: 'issued',
};

export function normalizeStatus(s: unknown, kind: RepairKind = 'client'): RepairStatus {
	const v = String(s ?? '');
	const order = statusOrder(kind);
	if (order.includes(v as RepairStatus)) return v as RepairStatus;
	if (kind === 'client' && LEGACY_STATUS[v]) return LEGACY_STATUS[v]!;
	return order[0]!;
}
