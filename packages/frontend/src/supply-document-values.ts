import { type SupplyOrderRow, type SupplyPurchaseChild, type SupplyTransferChild } from './b24.js';

export const money = (value: number): string =>
	new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);

export const sameStore = (left: string | undefined, right: string | undefined): boolean =>
	Boolean(left?.trim() && right?.trim())
	&& left!.trim().toLocaleLowerCase('ru-RU') === right!.trim().toLocaleLowerCase('ru-RU');

export function purchaseTransferAvailable(order: SupplyOrderRow, purchase: SupplyPurchaseChild): Map<number, number> {
	const requested = new Map<number, number>();
	for (const line of order.originalItems ?? order.items) requested.set(line.productId, (requested.get(line.productId) ?? 0) + Number(line.qty || 0));
	const covered = new Map<number, number>();
	const forwarded = new Map<number, number>();
	for (const transfer of order.transfers ?? []) {
		if (transfer.status === 'canceled' || transfer.correctionOf) continue;
		for (const line of transfer.lines) {
			covered.set(line.productId, (covered.get(line.productId) ?? 0) + Number(line.qty || 0));
			if (transfer.purchaseOrder === purchase.name) forwarded.set(line.productId, (forwarded.get(line.productId) ?? 0) + Number(line.qty || 0));
		}
	}
	const received = new Map<number, number>();
	for (const receipt of purchase.receipts) {
		if (receipt.docstatus !== 1) continue;
		for (const line of receipt.lines) {
		// Прямой приход уже находится на складе назначения заявки — перемещать его
		// со склада в тот же самый склад не требуется.
			if (sameStore(line.warehouse, order.toStore)) continue;
			received.set(line.productId, (received.get(line.productId) ?? 0) + Number(line.qty || 0));
		}
	}
	return new Map(purchase.lines.map((line) => {
		const alreadyForwarded = forwarded.get(line.productId) ?? 0;
		const onReceiptStore = Math.max((received.get(line.productId) ?? 0) - alreadyForwarded, 0);
		const neededAtPoint = Math.max((requested.get(line.productId) ?? 0) - (covered.get(line.productId) ?? 0), 0);
		const allocatedRemaining = Math.max(Math.min(Number(line.qty || 0), Number(line.requestQty ?? line.qty)) - alreadyForwarded, 0);
		return [line.productId, Math.min(onReceiptStore, neededAtPoint, allocatedRemaining)];
	}));
}

export const transferStatus = (transfer: SupplyTransferChild): { label: string; tone: string } => {
	if (transfer.status === 'draft') return { label: 'Черновик', tone: 'muted' };
	if (transfer.status === 'collected') return { label: 'Собрано', tone: 'info' };
	if (transfer.status === 'received') return { label: 'Получено', tone: 'ok' };
	if (transfer.status === 'accepted') return { label: 'На проверке', tone: 'info' };
	if (transfer.status === 'posted') return { label: transfer.correctionOf ? 'Завершено' : 'Принято', tone: 'ok' };
	if (transfer.status === 'shortage') return { label: 'Недовоз', tone: 'warn' };
	if (transfer.status === 'in_transit') return { label: 'В пути', tone: 'info' };
	if (transfer.status === 'canceled') return { label: 'Отменено', tone: 'muted' };
	return { label: 'Создано', tone: 'muted' };
};

export const transferHasDiscrepancy = (transfer: SupplyTransferChild): boolean => {
	if (transfer.status === 'shortage') return true;
	if (transfer.status === 'collected') {
		const collected = new Map((transfer.collectedLines ?? []).map((line) => [line.productId, line.qty]));
		return transfer.lines.some((line) => Math.abs(line.qty - (collected.get(line.productId) ?? 0)) > 0.000001);
	}
	if (transfer.status !== 'accepted') return false;
	const shipped = new Map((transfer.shippedLines ?? transfer.lines).map((line) => [line.productId, line.qty]));
	const accepted = new Map((transfer.acceptedLines ?? transfer.receivedLines ?? []).map((line) => [line.productId, line.qty]));
	return [...new Set([...shipped.keys(), ...accepted.keys()])].some((id) => Math.abs((shipped.get(id) ?? 0) - (accepted.get(id) ?? 0)) > 0.000001);
};

const TRANSFER_HISTORY_LABELS: Record<string, string> = {
	created: 'Создано',
	lines_changed: 'Количество изменено',
	destination_changed: 'Склад назначения изменен',
	collected: 'Собрано',
	shipped: 'Отправлено',
	accepted: 'Принято',
	posted: 'Проведено',
	canceled: 'Отменено',
	notification_sent: 'Сообщение отправлено',
	notification_failed: 'Сообщение не отправлено',
	legacy: 'Изменено',
};

export const transferHistoryLabel = (event: { note?: string; action?: string; status: string }): string =>
	event.note || (event.action ? TRANSFER_HISTORY_LABELS[event.action] : '') || event.status;

export const transferDocumentLabel = (transfer: SupplyTransferChild): string => {
	const entries = [transfer.shipEntry, transfer.receiveEntry || transfer.shortageReturnEntry].filter((name): name is string => Boolean(name));
	return entries.length ? entries.join(' → ') : `#${transfer.id}`;
};

export const lineTitle = (line: { name?: string; itemName?: string; productId: number; qty: number }): string =>
	`${line.name || line.itemName || `#${line.productId}`} ×${line.qty}`;

export const documentAmount = (lines: Array<{ qty: number }>): string => {
	const qty = lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
	return `${lines.length} поз. · ${qty} шт`;
};
