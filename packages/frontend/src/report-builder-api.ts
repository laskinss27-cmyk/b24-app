import { bx24Auth } from './b24.js';

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportField {
	id: string;
	label: string;
	type: 'text' | 'number' | 'date';
	role: 'dimension' | 'measure';
	aggregate?: 'sum' | 'average';
	defaultVisible?: boolean;
}

export interface ReportDataset {
	id: 'sales_deals' | 'stock_turnover';
	name: string;
	description: string;
	fields: ReportField[];
	filters: Array<'period' | 'store' | 'categories'>;
}

export interface ReportDefinition {
	datasetId: ReportDataset['id'];
	columns: string[];
	groupBy: string[];
	filters: { from: string; to: string; store?: string; categoryIds?: number[] };
	sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
}

export interface SavedReport {
	id: string;
	name: string;
	definition: ReportDefinition;
	createdAt: string;
	updatedAt: string;
}

export interface ReportBuilderBootstrap {
	user: { id: string; name: string; isAdmin: boolean };
	datasets: ReportDataset[];
	reports: SavedReport[];
	options: { categories: Array<{ id: number; name: string }>; stores: string[] };
}

export interface ReportRunResult {
	columns: ReportField[];
	rows: ReportRow[];
	totalRows: number;
	truncated: boolean;
	generatedAt: string;
}

async function request<T>(path: 'bootstrap' | 'run' | 'save' | 'delete', payload: Record<string, unknown> = {}): Promise<T> {
	const response = await fetch(`/api/report-builder/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...payload }),
	});
	const json = await response.json() as { ok?: boolean; error?: string };
	if (!response.ok || !json.ok) throw new Error(json.error ?? `ошибка запроса (HTTP ${response.status})`);
	return json as T;
}

export async function fetchReportBuilderBootstrap(): Promise<ReportBuilderBootstrap> {
	const result = await request<{ ok: true } & ReportBuilderBootstrap>('bootstrap');
	return result;
}

export async function runCustomReport(definition: ReportDefinition): Promise<ReportRunResult> {
	const result = await request<{ ok: true } & ReportRunResult>('run', { definition });
	return result;
}

export async function saveCustomReport(input: {
	id?: string;
	name: string;
	definition: ReportDefinition;
	expectedUpdatedAt?: string;
}): Promise<SavedReport> {
	const result = await request<{ ok: true; report: SavedReport }>('save', input);
	return result.report;
}

export async function deleteCustomReport(id: string): Promise<void> {
	await request<{ ok: true }>('delete', { id });
}
