import { z } from 'zod';

export const ReportDatasetIdSchema = z.enum(['sales_deals', 'stock_turnover']);
export type ReportDatasetId = z.infer<typeof ReportDatasetIdSchema>;

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportField {
	id: string;
	label: string;
	type: 'text' | 'number' | 'date';
	role: 'dimension' | 'measure';
	/** Агрегация при группировке. У измерений отсутствует. */
	aggregate?: 'sum' | 'average';
	defaultVisible?: boolean;
}

export interface ReportDataset {
	id: ReportDatasetId;
	name: string;
	description: string;
	fields: ReportField[];
	filters: Array<'period' | 'store' | 'categories'>;
}

export const REPORT_DATASETS: ReportDataset[] = [
	{
		id: 'sales_deals',
		name: 'Продажи по сделкам',
		description: 'Выигранные сделки и их финансовые показатели.',
		filters: ['period', 'categories'],
		fields: [
			{ id: 'dealId', label: 'ID сделки', type: 'number', role: 'dimension' },
			{ id: 'category', label: 'Воронка', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'source', label: 'Источник', type: 'text', role: 'dimension' },
			{ id: 'dateCreate', label: 'Дата создания', type: 'date', role: 'dimension' },
			{ id: 'dateClosed', label: 'Дата продажи', type: 'date', role: 'dimension', defaultVisible: true },
			{ id: 'closedMonth', label: 'Месяц продажи', type: 'text', role: 'dimension' },
			{ id: 'title', label: 'Сделка', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'manager', label: 'Менеджер', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'goodsSum', label: 'Продажа товаров', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'worksSum', label: 'Продажа работ', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'totalSum', label: 'Общая продажа', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'goodsProfit', label: 'Прибыль товаров', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'worksProfit', label: 'Прибыль работ', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'totalProfit', label: 'Общая прибыль', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'goodsNoPurchase', label: 'Позиций без закупки', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: '__count', label: 'Количество сделок', type: 'number', role: 'measure', aggregate: 'sum' },
		],
	},
	{
		id: 'stock_turnover',
		name: 'Склад и оборачиваемость',
		description: 'Остатки, продажи и движение товаров по данным ядра.',
		filters: ['period', 'store'],
		fields: [
			{ id: 'productId', label: 'ID товара', type: 'number', role: 'dimension' },
			{ id: 'article', label: 'Артикул', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'name', label: 'Товар', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'brand', label: 'Бренд', type: 'text', role: 'dimension' },
			{ id: 'section', label: 'Категория', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'status', label: 'Состояние запаса', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'currentQty', label: 'Текущий остаток', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'reservedQty', label: 'Зарезервировано', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'orderedQty', label: 'Заказано', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'availableQty', label: 'Доступно', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'openingQty', label: 'Остаток на начало', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'closingQty', label: 'Остаток на конец', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'averageQty', label: 'Средний остаток', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'receivedQty', label: 'Поступило', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'soldQty', label: 'Продано', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'returnedQty', label: 'Возвращено', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'writtenOffQty', label: 'Списано', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'turns', label: 'Оборотов за период', type: 'number', role: 'measure', aggregate: 'average' },
			{ id: 'dailySales', label: 'Продаж в день', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'daysOfStock', label: 'Запас на дней', type: 'number', role: 'measure', aggregate: 'average', defaultVisible: true },
			{ id: 'averagePurchasePrice', label: 'Средняя закупочная цена', type: 'number', role: 'measure', aggregate: 'average' },
			{ id: 'stockValue', label: 'Стоимость остатка', type: 'number', role: 'measure', aggregate: 'sum' },
			{ id: 'lastReceiptDate', label: 'Последнее поступление', type: 'date', role: 'dimension' },
			{ id: 'lastSaleDate', label: 'Последняя продажа', type: 'date', role: 'dimension' },
			{ id: '__count', label: 'Количество товаров', type: 'number', role: 'measure', aggregate: 'sum' },
		],
	},
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ReportDefinitionSchema = z.object({
	datasetId: ReportDatasetIdSchema,
	columns: z.array(z.string().min(1).max(50)).min(1).max(24),
	groupBy: z.array(z.string().min(1).max(50)).max(3).default([]),
	filters: z.object({
		from: z.string().regex(DATE_RE),
		to: z.string().regex(DATE_RE),
		store: z.string().trim().max(200).optional(),
		categoryIds: z.array(z.number().int().nonnegative()).max(100).optional(),
	}).strict(),
	sort: z.array(z.object({
		field: z.string().min(1).max(50),
		direction: z.enum(['asc', 'desc']),
	}).strict()).max(3).default([]),
}).strict();

export type ReportDefinition = z.infer<typeof ReportDefinitionSchema>;

export interface SavedReport {
	id: string;
	name: string;
	definition: ReportDefinition;
	createdAt: string;
	updatedAt: string;
}

export function datasetById(id: ReportDatasetId): ReportDataset {
	const dataset = REPORT_DATASETS.find((item) => item.id === id);
	if (!dataset) throw new Error('неизвестный источник отчёта');
	return dataset;
}

function validCalendarDate(value: string): boolean {
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateReportDefinition(value: unknown): ReportDefinition {
	const definition = ReportDefinitionSchema.parse(value);
	if (!validCalendarDate(definition.filters.from) || !validCalendarDate(definition.filters.to)) {
		throw new Error('указана несуществующая дата');
	}
	if (definition.filters.from > definition.filters.to) throw new Error('дата «от» должна быть раньше даты «до»');
	const days = (Date.parse(`${definition.filters.to}T00:00:00Z`) - Date.parse(`${definition.filters.from}T00:00:00Z`)) / 86_400_000 + 1;
	if (days > 366) throw new Error('один отчёт можно построить максимум за 366 дней');

	const dataset = datasetById(definition.datasetId);
	const fields = new Map(dataset.fields.map((field) => [field.id, field]));
	const allRequested = [...definition.columns, ...definition.groupBy, ...definition.sort.map((item) => item.field)];
	if (allRequested.some((id) => !fields.has(id))) throw new Error('в отчёте выбрано неизвестное поле');
	if (new Set(definition.columns).size !== definition.columns.length || new Set(definition.groupBy).size !== definition.groupBy.length) {
		throw new Error('поля отчёта не должны повторяться');
	}
	for (const id of definition.groupBy) {
		if (fields.get(id)?.role !== 'dimension') throw new Error('группировать можно только по измерениям');
	}
	if (definition.groupBy.length) {
		for (const id of definition.columns) {
			const field = fields.get(id);
			if (field?.role === 'dimension' && !definition.groupBy.includes(id)) {
				throw new Error(`поле «${field.label}» нужно добавить в группировку или убрать из колонок`);
			}
		}
	}
	const outputIds = new Set([...definition.groupBy, ...definition.columns]);
	if (definition.sort.some((item) => !outputIds.has(item.field))) throw new Error('сортировать можно только по колонке результата');
	return definition;
}

function compareCells(left: ReportCell, right: ReportCell): number {
	if (left == null && right == null) return 0;
	if (left == null) return 1;
	if (right == null) return -1;
	if (typeof left === 'number' && typeof right === 'number') return left - right;
	return String(left).localeCompare(String(right), 'ru', { numeric: true, sensitivity: 'base' });
}

function round(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function buildReportResult(definitionInput: unknown, sourceRows: ReportRow[]): {
	columns: ReportField[];
	rows: ReportRow[];
	totalRows: number;
	truncated: boolean;
} {
	const definition = validateReportDefinition(definitionInput);
	const dataset = datasetById(definition.datasetId);
	const fields = new Map(dataset.fields.map((field) => [field.id, field]));
	const outputIds = [...new Set([...definition.groupBy, ...definition.columns])];
	let rows: ReportRow[];

	if (!definition.groupBy.length) {
		rows = sourceRows.map((source) => Object.fromEntries(outputIds.map((id) => [id, source[id] ?? null])));
	} else {
		const groups = new Map<string, { row: ReportRow; counts: Record<string, number> }>();
		for (const source of sourceRows) {
			const key = JSON.stringify(definition.groupBy.map((id) => source[id] ?? null));
			let group = groups.get(key);
			if (!group) {
				group = { row: {}, counts: {} };
				for (const id of definition.groupBy) group.row[id] = source[id] ?? null;
				for (const id of definition.columns) if (fields.get(id)?.role === 'measure') group.row[id] = 0;
				groups.set(key, group);
			}
			for (const id of definition.columns) {
				const field = fields.get(id);
				if (field?.role !== 'measure') continue;
				const rawValue = source[id];
				if (rawValue == null || rawValue === '') continue;
				const value = Number(rawValue);
				if (!Number.isFinite(value)) continue;
				group.row[id] = Number(group.row[id] ?? 0) + value;
				group.counts[id] = (group.counts[id] ?? 0) + 1;
			}
		}
		rows = [...groups.values()].map((group) => {
			for (const id of definition.columns) {
				const field = fields.get(id);
				if (field?.aggregate === 'average') {
					const count = group.counts[id] ?? 0;
					group.row[id] = count ? round(Number(group.row[id] ?? 0) / count) : null;
				} else if (field?.role === 'measure') {
					group.row[id] = round(Number(group.row[id] ?? 0));
				}
			}
			return group.row;
		});
	}

	if (definition.sort.length) {
		rows.sort((left, right) => {
			for (const sort of definition.sort) {
				const compared = compareCells(left[sort.field] ?? null, right[sort.field] ?? null);
				if (compared) return sort.direction === 'asc' ? compared : -compared;
			}
			return 0;
		});
	}
	const totalRows = rows.length;
	return {
		columns: outputIds.map((id) => fields.get(id)).filter((field): field is ReportField => Boolean(field)),
		rows: rows.slice(0, 1000),
		totalRows,
		truncated: totalRows > 1000,
	};
}
