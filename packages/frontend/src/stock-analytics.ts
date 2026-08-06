import { bx24Auth } from './bitrix-auth.js';

export type TurnoverStatus = 'ending' | 'ordered' | 'normal' | 'excess' | 'no_movement' | 'no_stock';
export interface TurnoverReportRow {
	productId: number;
	name: string;
	article: string;
	brand: string;
	section: string;
	currentQty: number;
	reservedQty: number;
	orderedQty: number;
	availableQty: number;
	openingQty: number;
	closingQty: number;
	averageQty: number;
	receivedQty: number;
	soldQty: number;
	returnedQty: number;
	writtenOffQty: number;
	turns: number | null;
	dailySales: number;
	daysOfStock: number | null;
	averagePurchasePrice: number | null;
	stockValue: number | null;
	lastReceiptDate: string;
	lastSaleDate: string;
	status: TurnoverStatus;
}

export type AssortmentMatrixSalesScope = 'selected' | 'all';
export interface AssortmentMatrixRow {
	productId: number;
	name: string;
	article: string;
	model: string;
	brand: string;
	category: string;
	segment: string;
	stocks: Record<string, number>;
	totalStock: number;
	reservedQty: number;
	freeQty: number;
	orderedQty: number;
	soldQty: number;
	recommendedQty: number;
	toOrderQty: number;
	comment: string;
}

export interface AssortmentMatrixReport {
	rows: AssortmentMatrixRow[];
	stores: string[];
	selectedStores: string[];
	categories: string[];
	salesScope: AssortmentMatrixSalesScope;
	periodDays: number;
	targetDays: number;
	generatedAt: string;
}

/** Канареечная матрица ассортимента и заказа. */
export async function fetchAssortmentMatrix(input: {
	from: string;
	to: string;
	selectedStores: string[];
	salesScope: AssortmentMatrixSalesScope;
}): Promise<AssortmentMatrixReport> {
	const res = await fetch('/api/stock/assortment-matrix', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<AssortmentMatrixReport>;
	if (!json.ok) throw new Error(json.error ?? 'не удалось построить матрицу заказа');
	return {
		rows: json.rows ?? [],
		stores: json.stores ?? [],
		selectedStores: json.selectedStores ?? input.selectedStores,
		categories: json.categories ?? [],
		salesScope: json.salesScope ?? input.salesScope,
		periodDays: Number(json.periodDays ?? 0),
		targetDays: Number(json.targetDays ?? 60),
		generatedAt: json.generatedAt ?? '',
	};
}

export async function saveAssortmentMatrixItem(input: {
	productId: number;
	enabled: boolean;
	category: string;
	segment: string;
	toOrderQty: number;
	comment: string;
}): Promise<void> {
	const res = await fetch('/api/stock/assortment-matrix/save', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить строку матрицы');
}

/** Оборачиваемость всех складских позиций за произвольный период. Только чтение ядра. */
export async function fetchTurnoverReport(from: string, to: string, store?: string): Promise<{ rows: TurnoverReportRow[]; generatedAt: string; days: number }> {
	const res = await fetch('/api/stock/turnover-report', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), from, to, ...(store ? { store } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: TurnoverReportRow[]; generatedAt?: string; days?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось построить отчёт оборачиваемости');
	return { rows: json.rows ?? [], generatedAt: json.generatedAt ?? '', days: Number(json.days ?? 0) };
}

/** Скачать Excel-версию отчёта с теми же фильтрами и видимыми ценовыми колонками. */
export async function downloadTurnoverReportXlsx(input: {
	from: string;
	to: string;
	store?: string;
	search?: string;
	status?: TurnoverStatus;
	section?: string;
	showAverageCost: boolean;
	showStockValue: boolean;
}): Promise<void> {
	const res = await fetch('/api/stock/turnover-report.xlsx', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
		let message = `не удалось сформировать Excel (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `turnover-${input.from}-${input.to}.xlsx`;
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

// ── Формы создания в окне «Складской учёт» ────────────────────────────────────

/** Найденный в каталоге ядра товар (пикер позиций). stocks/total — остатки по складам (для наличия в пикере). */
