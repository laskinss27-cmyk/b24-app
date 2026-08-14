import type { ReportCell, ReportField, ReportRow } from './report-builder-api.js';

export interface ReportResultColumnFilter {
	text?: string;
	min?: string;
	max?: string;
	from?: string;
	to?: string;
}

export type ReportResultFilters = Record<string, ReportResultColumnFilter>;

function numericBound(value: string | undefined): number | null {
	if (!value?.trim()) return null;
	const parsed = Number(value.replace(',', '.'));
	return Number.isFinite(parsed) ? parsed : null;
}

export function activeReportResultFilterCount(filters: ReportResultFilters): number {
	return Object.values(filters).filter((filter) => Object.values(filter).some((value) => Boolean(value?.trim()))).length;
}

export function filterReportResultRows(
	rows: ReportRow[],
	columns: ReportField[],
	filters: ReportResultFilters,
	format: (value: ReportCell, field: ReportField) => string = (value) => value == null ? '' : String(value),
): ReportRow[] {
	const active = columns.flatMap((field) => {
		const filter = filters[field.id];
		return filter && Object.values(filter).some((value) => Boolean(value?.trim())) ? [{ field, filter }] : [];
	});
	if (!active.length) return rows;
	return rows.filter((row) => active.every(({ field, filter }) => {
		const value = row[field.id] ?? null;
		if (field.type === 'number') {
			const min = numericBound(filter.min);
			const max = numericBound(filter.max);
			if (min == null && max == null) return true;
			const number = typeof value === 'number' ? value : Number(value);
			return Number.isFinite(number) && (min == null || number >= min) && (max == null || number <= max);
		}
		if (field.type === 'date') {
			const date = value == null ? '' : String(value).slice(0, 10);
			return Boolean(date) && (!filter.from || date >= filter.from) && (!filter.to || date <= filter.to);
		}
		const query = filter.text?.trim().toLocaleLowerCase('ru-RU') ?? '';
		return !query || format(value, field).toLocaleLowerCase('ru-RU').includes(query);
	}));
}
