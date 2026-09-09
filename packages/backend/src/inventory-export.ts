import { inventorySnapshotQuantities, inventoryCountQuantities } from './inventory-stock-snapshot.js';
import { inventoryMoneyTotals } from '@b24-app/shared';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const quantity = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const validId = (value: unknown): number => {
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Повреждён ID товара в инвентаризации');
	return id;
};

export interface InventoryExportLine {
	productId: number;
	name: string;
	article: string;
	book: number | null;
	fact: number | null;
	diff: number | null;
	comment: string;
	retailPrice?: number;
}
export interface InventoryExportPoint {
	storeId: number;
	storeName: string;
	responsible: string;
	status: string;
	snapshotAt: string;
	note: string;
	lines: InventoryExportLine[];
	money?: ReturnType<typeof inventoryMoneyTotals>;
}
export interface InventoryExport {
	id: string;
	title: string;
	createdAt: string;
	deadline: string;
	points: InventoryExportPoint[];
}

/** Only persisted inventory quantities are exported. Never substitute current stock. */
export function prepareInventoryExport(item: RecordValue, storeId?: number): InventoryExport {
	const data = record(JSON.parse(String(item['DETAIL_TEXT'] ?? '{}')));
	if (!Array.isArray(data['points'])) throw new Error('Повреждён список складов инвентаризации');
	const points: InventoryExportPoint[] = [];
	for (const raw of data['points']) {
		const point = record(raw);
		if (storeId !== undefined && Number(point['storeId']) !== storeId) continue;
		const snapshot = inventorySnapshotQuantities(point);
		if (point['stockSnapshot'] || data['stockSnapshotAt']) {
			const rawSnapshot = record(point['stockSnapshot']);
			if (!snapshot || rawSnapshot['version'] !== 1 || !Array.isArray(rawSnapshot['lines']) || rawSnapshot['lines'].length !== snapshot.size
				|| rawSnapshot['lines'].some((line: unknown) => !Array.isArray(line) || quantity(line[1]) === null || Number(line[1]) < 0)) {
				throw new Error(`Повреждён снимок остатков: ${String(point['storeName'] ?? '')}`);
			}
		}
		const result = record(point['result']);
		const countBasis = inventoryCountQuantities(point);
		const results = new Map<number, RecordValue>();
		for (const value of Array.isArray(result['lines']) ? result['lines'] : []) {
			const row = record(value);
			results.set(validId(row['productId']), row);
		}
		const draft = record(point['draft']);
		const comments = record(point['comments']);
		const hasDraft = point['draft'] != null;
		const ids = new Set([...snapshot?.keys() ?? [], ...results.keys(), ...Object.keys(draft).map(validId), ...Object.keys(comments).map(validId)]);
		const lines = [...ids].map((productId): InventoryExportLine => {
			const saved = results.get(productId);
			const book = countBasis ? countBasis.get(productId) ?? 0 : quantity(saved?.['book']);
			const fact = quantity(hasDraft ? draft[productId] : saved?.['fact']);
			return {
				productId, name: String(saved?.['name'] ?? ''), article: '', book, fact,
				diff: book !== null && fact !== null ? Math.round((fact - book) * 1e9) / 1e9 : null,
				comment: String(comments[productId] ?? saved?.['comment'] ?? ''),
				...(quantity(saved?.['retailPrice']) !== null && fact === quantity(saved?.['fact']) ? { retailPrice: Number(saved?.['retailPrice']) } : {}),
			};
		});
		const notes = [];
		if (point['resultBookAt']) notes.push(`Использована отдельно подтверждённая база пересчёта ${String(point['resultBookAt'])}. Исходный снимок открытия сохранён.`);
		const money = Array.isArray(result['lines']) ? inventoryMoneyTotals([...results.values()].map((line) => ({
			diff: Number(line['fact']) - Number(line['book']),
			...(quantity(line['retailPrice']) !== null ? { retailPrice: Number(line['retailPrice']) } : {}),
		}))) : undefined;
		if (money) {
			notes.push('Денежные итоги — по последнему отправленному отчёту и розничным ценам на момент отправки.');
			if (money.missingShortage + money.missingSurplus) notes.push(`Нет сохранённой цены для ${money.missingShortage + money.missingSurplus} поз. с расхождением.`);
		}
		if (!snapshot) notes.push('Старая ревизия без снимка: выгружены только сохранённые позиции. Неизвестный учёт оставлен пустым.');
		if (Number(result['counted']) > lines.filter((line) => line.fact !== null).length) {
			notes.push('Часть фактов прежнего раунда не сохранена по товарам и оставлена пустой.');
		}
		points.push({ storeId: Number(point['storeId']), storeName: String(point['storeName'] ?? ''),
			responsible: String(point['responsibleName'] ?? ''), status: String(point['status'] ?? 'idle'),
			snapshotAt: String(record(point['stockSnapshot'])['capturedAt'] ?? ''), note: notes.join(' '), lines, ...(money ? { money } : {}) });
	}
	if (!points.length) throw new Error('Склад инвентаризации не найден');
	return { id: String(item['ID']), title: String(item['NAME'] ?? 'Инвентаризация'),
		createdAt: String(data['createdAt'] ?? item['DATE_CREATE'] ?? ''), deadline: String(data['deadline'] ?? ''), points };
}
