/**
 * Уведомления по резервам: точка (склад) узнаёт о запросе на резерв и о его
 * окончании (товар возвращается на полки). Модуль чистый: текст и группировка
 * отделены от доставки (сообщения в складские чаты собирает слой роутов).
 */

export type ReservationNoticeKind = 'requested' | 'released' | 'expired' | 'consumed';

export interface ReservationNoticeItem {
	itemCode: string;
	itemName: string;
	quantity: string;
}

export interface ReservationNoticeStore {
	erpWarehouseName: string;
	items: ReservationNoticeItem[];
}

export interface ReservationNotice {
	kind: ReservationNoticeKind;
	reservationId: string | null;
	requestId: string | null;
	dealId: number | null;
	comment: string | null;
	expiresAt: string | null;
	stores: ReservationNoticeStore[];
}

export type ReservationNoticeSink = (notices: ReservationNotice[]) => Promise<void>;

const NOTICE_META: Record<ReservationNoticeKind, { title: string; body: string }> = {
	requested: { title: 'Резерв: новая заявка', body: 'Поступила заявка на резерв со склада' },
	released: { title: 'Резерв снят', body: 'Резерв снят. Товар вернулся в продажу — верните его на полки' },
	expired: { title: 'Резерв истёк', body: 'Срок резерва истёк. Верните зарезервированный товар на полки' },
	consumed: { title: 'Резерв использован', body: 'Резерв списан реализацией. Товар ушёл со склада' },
};

export function groupLinesByStore(
	lines: ReadonlyArray<Pick<ReservationNoticeItem, 'itemCode' | 'itemName' | 'quantity'> & { erpWarehouseName: string }>,
): ReservationNoticeStore[] {
	const byStore = new Map<string, ReservationNoticeItem[]>();
	for (const line of lines) {
		const items = byStore.get(line.erpWarehouseName) ?? [];
		items.push({ itemCode: line.itemCode, itemName: line.itemName, quantity: line.quantity });
		byStore.set(line.erpWarehouseName, items);
	}
	return [...byStore.entries()].map(([erpWarehouseName, items]) => ({ erpWarehouseName, items }));
}

export function buildRequestedNotice(args: {
	requestId: string;
	dealId: number | null;
	comment: string | null;
	requestedExpiresAt: string;
	lines: ReadonlyArray<Pick<ReservationNoticeItem, 'itemCode' | 'itemName' | 'quantity'> & { erpWarehouseName: string }>;
}): ReservationNotice {
	if (!args.lines.length) throw new Error('Reservation request notice requires at least one line');
	return {
		kind: 'requested', reservationId: null, requestId: args.requestId, dealId: args.dealId,
		comment: args.comment, expiresAt: args.requestedExpiresAt, stores: groupLinesByStore(args.lines),
	};
}

export function buildEndedNotice(
	kind: 'released' | 'expired' | 'consumed',
	args: {
		reservationId: string;
		dealId: number | null;
		lines: ReadonlyArray<Pick<ReservationNoticeItem, 'itemCode' | 'itemName' | 'quantity'> & { erpWarehouseName: string }>;
	},
): ReservationNotice {
	if (!args.lines.length) throw new Error('Reservation end notice requires at least one line');
	return {
		kind, reservationId: args.reservationId, requestId: null, dealId: args.dealId,
		comment: null, expiresAt: null, stores: groupLinesByStore(args.lines),
	};
}

/** Текст сообщения в складской чат для одной точки уведомления. */
export function reservationNoticeChatText(notice: ReservationNotice, store: ReservationNoticeStore, storeTitle: string): string {
	const meta = NOTICE_META[notice.kind];
	const subject = notice.reservationId ? `Резерв №${notice.reservationId}` : notice.requestId ? `Заявка №${notice.requestId}` : 'Резерв';
	const items = store.items.map((item) => `— ${item.itemName} (#${item.itemCode}) · ${item.quantity} шт.`).join('\n');
	const lines = [
		`${meta.title}: ${subject} — склад «${storeTitle}»`,
		``,
		meta.body + ` «${storeTitle}».`,
		items,
	];
	if (notice.kind === 'requested' && notice.expiresAt) {
		lines.push(``, `Запрошенный срок резерва: ${new Date(notice.expiresAt).toLocaleString('ru-RU')}`);
	}
	if (notice.dealId != null) lines.push(`Сделка: №${notice.dealId}`);
	if (notice.comment) lines.push(`Комментарий: ${notice.comment}`);
	return lines.join('\n');
}
