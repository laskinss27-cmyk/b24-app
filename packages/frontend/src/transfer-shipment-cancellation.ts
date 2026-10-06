export interface ShipmentCancellationInput { reason: string; goodsStayedAtSource: true }

export function confirmMistakenShipment(fromStore: string): ShipmentCancellationInput | null {
	const reason = window.prompt('Почему отправка ошибочна? Укажи причину отмены (5–500 символов).');
	if (reason === null) return null;
	if (reason.trim().length < 5 || reason.trim().length > 500) {
		window.alert('Укажи причину длиной от 5 до 500 символов.');
		return null;
	}
	if (!window.confirm(`Подтверждаешь, что ВЕСЬ товар физически остался на складе «${fromStore}» и не отправлялся?\n\nБудет создано обратное движение из транзита, а перемещение закроется как отменённое. Если товар уже уехал, отменять отправку нельзя.`)) return null;
	return { reason: reason.trim(), goodsStayedAtSource: true };
}
