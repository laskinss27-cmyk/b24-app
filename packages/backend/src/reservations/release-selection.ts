import { formatReservationQuantity, parseReservationQuantity } from './domain.js';

export interface ReleaseSelection { lineId: string; quantity: string }
export interface ActiveReleaseLine { id: string; activeQuantity: string }

/** Omitted selection is the legacy full-release contract. Explicit empty input never means all. */
export function selectReleaseLines(active: ActiveReleaseLine[], input: unknown): ReleaseSelection[] {
	const selected = input === undefined ? active.filter((line) => parseReservationQuantity(line.activeQuantity) > 0n)
		.map((line) => ({ lineId: line.id, quantity: line.activeQuantity })) : input;
	if (!Array.isArray(selected) || !selected.length) throw new Error('Выберите товары и количество для снятия');
	const seen = new Set<string>();
	return selected.map((value: unknown) => {
		if (!value || typeof value !== 'object') throw new Error('Некорректная строка снятия');
		const row = value as Record<string, unknown>;
		const lineId = String(row['lineId'] ?? '');
		const line = active.find((candidate) => candidate.id === lineId);
		if (!line || seen.has(lineId)) throw new Error('Строка резерва не найдена или указана повторно');
		seen.add(lineId);
		let quantity: bigint;
		try { quantity = parseReservationQuantity(String(row['quantity'])); }
		catch { throw new Error('Укажите корректное количество для снятия (до 9 знаков после запятой)'); }
		if (quantity <= 0n || quantity > parseReservationQuantity(line.activeQuantity)) {
			throw new Error('Количество превышает текущий резерв или равно нулю. Обновите данные и запрос на снятие');
		}
		return { lineId, quantity: formatReservationQuantity(quantity) };
	});
}

export function readReleaseSelection(value: unknown): ReleaseSelection[] | null {
	if (value == null) return null;
	const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
	if (!Array.isArray(parsed) || !parsed.length) throw new Error('Повреждён состав запроса снятия');
	return parsed as ReleaseSelection[];
}
