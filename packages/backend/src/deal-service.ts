import type { B24Client } from './b24/client.js';

/** Единственная служебная строка, которую Битрикс показывает вместо состава сделки из ядра. */
export const B24_COLLAPSE_SERVICE_PRODUCT_ID = 9814;
export const B24_COLLAPSE_SERVICE_NAME = 'Отгрузка подтверждена на сумму';

/** Настоящая нескладская услуга платного ремонта в каталоге и ядре. */
export const PAID_REPAIR_SERVICE_PRODUCT_ID = 19108;
export const PAID_REPAIR_SERVICE_NAME = 'Платный ремонт';
export const WARRANTY_REPAIR_SERVICE_NAME = 'Гарантийный ремонт';

export interface RepairDealPlanLine {
	productId: number;
	itemName?: string;
	qty: number;
	priceListRate: number;
	discountPercent: number;
	isService?: boolean;
}

/** Обновить только ремонтную услугу, не затрагивая оборудование и другие услуги сделки. */
export function mergeRepairServiceLine(
	currentPlan: RepairDealPlanLine[],
	payType: 'paid' | 'warranty',
	price: number,
): RepairDealPlanLine[] {
	if (!Number.isFinite(price) || price < 0) throw new Error('цена платного ремонта должна быть неотрицательным числом');
	const lines = currentPlan
		.filter((line) => line.productId !== PAID_REPAIR_SERVICE_PRODUCT_ID)
		.map((line) => ({ ...line }));
	if (payType === 'paid') {
		lines.push({
			productId: PAID_REPAIR_SERVICE_PRODUCT_ID,
			itemName: PAID_REPAIR_SERVICE_NAME,
			qty: 1,
			priceListRate: price,
			discountPercent: 0,
			isService: true,
		});
	}
	return lines;
}

const normalizeLegacyRowName = (value: unknown): string =>
	String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Ремонтный модуль исторически писал «Платный ремонт» свободной строкой PRODUCT_ID=0.
 * В ядре это настоящая услуга 19108. Остальные неизвестные свободные строки остаются
 * заблокированными, чтобы при переносе старой сделки не потерять её состав.
 */
export function normalizeLegacyB24DealRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const candidates = rows.filter((row) =>
		Number(row['QUANTITY'] ?? 0) > 0
		&& Number(row['PRODUCT_ID'] ?? 0) !== B24_COLLAPSE_SERVICE_PRODUCT_ID);
	const customRows = candidates.filter((row) => Number(row['PRODUCT_ID'] ?? 0) <= 0);
	if (!customRows.length) return candidates;

	const paidName = normalizeLegacyRowName(PAID_REPAIR_SERVICE_NAME);
	const warrantyName = normalizeLegacyRowName(WARRANTY_REPAIR_SERVICE_NAME);
	const paidRows = customRows.filter((row) => normalizeLegacyRowName(row['PRODUCT_NAME']) === paidName);
	const warrantyRows = customRows.filter((row) => normalizeLegacyRowName(row['PRODUCT_NAME']) === warrantyName);
	const knownRows = new Set([...paidRows, ...warrantyRows]);
	const unknownRows = customRows.filter((row) => !knownRows.has(row));

	if (unknownRows.length) {
		const names = unknownRows.map((row) => String(row['PRODUCT_NAME'] ?? '').trim()).filter(Boolean).slice(0, 3);
		throw new Error(`в старой сделке есть позиции без карточки товара${names.length ? `: ${names.join(', ')}` : ''}; сначала оформите их как товары каталога`);
	}
	if (paidRows.length > 1) {
		throw new Error('в сделке найдено несколько свободных строк «Платный ремонт»; проверьте сумму и удалите дубль');
	}
	if (paidRows.length && candidates.some((row) => Number(row['PRODUCT_ID'] ?? 0) === PAID_REPAIR_SERVICE_PRODUCT_ID)) {
		throw new Error('в сделке одновременно найдены карточка и свободная строка «Платный ремонт»; проверьте дубль');
	}
	for (const row of paidRows) {
		const qty = Number(row['QUANTITY']);
		const price = Number(row['PRICE']);
		if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
			throw new Error('у строки «Платный ремонт» указаны некорректные количество или цена');
		}
	}
	for (const row of warrantyRows) {
		const price = Number(row['PRICE'] ?? 0);
		if (!Number.isFinite(price) || Math.abs(price) > 0.000001) {
			throw new Error('у свободной строки «Гарантийный ремонт» указана ненулевая цена; проверьте сделку');
		}
	}

	const ordinaryRows = candidates.filter((row) => Number(row['PRODUCT_ID'] ?? 0) > 0);
	return [
		...ordinaryRows,
		...paidRows.map((row) => ({
			...row,
			PRODUCT_ID: PAID_REPAIR_SERVICE_PRODUCT_ID,
			PRODUCT_NAME: PAID_REPAIR_SERVICE_NAME,
			TYPE: 7,
		})),
	];
}

/** Показать в сделке Битрикса только одну служебную строку с общей суммой из ядра. */
export async function setDealB24CollapsedService(client: B24Client, dealId: number, total: number): Promise<void> {
	await client.call('crm.deal.productrows.set', {
		id: dealId,
		rows: total > 0
			? [{
				PRODUCT_ID: B24_COLLAPSE_SERVICE_PRODUCT_ID,
				PRODUCT_NAME: B24_COLLAPSE_SERVICE_NAME,
				PRICE: total,
				QUANTITY: 1,
				MEASURE_CODE: 796,
			}]
			: [],
	});
}
