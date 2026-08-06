import { bx24Auth } from './bitrix-auth.js';
import { call } from './bitrix-client.js';

export interface SimpleUser {
	id: string;
	name: string;
}
/** Активные сотрудники — для назначения ответственных (v1: первая страница ~50). */
export async function fetchUsers(): Promise<SimpleUser[]> {
	const users = await call<Array<Record<string, unknown>>>('user.get', { FILTER: { ACTIVE: true }, SORT: 'LAST_NAME', ORDER: 'ASC' });
	return (users ?? []).map((u) => ({
		id: String(u['ID']),
		name: `${u['LAST_NAME'] ?? ''} ${u['NAME'] ?? ''}`.trim() || String(u['ID']),
	}));
}

// ── Отчёт по продажам (за период по менеджерам) ───────────────────────────────

/** Воронки сделок (CATEGORY_ID + название) для фильтра отчёта. */
export async function fetchDealCategories(): Promise<{ id: number; name: string }[]> {
	const res = await call<{ categories?: Array<Record<string, unknown>> }>('crm.category.list', { entityTypeId: 2 });
	const list = (res?.categories ?? []).map((c) => ({ id: Number(c['id']), name: String(c['name'] ?? `Воронка ${c['id']}`) }));
	if (!list.some((c) => c.id === 0)) list.unshift({ id: 0, name: 'Объекты' });
	return list.sort((a, b) => a.id - b.id);
}

/** Строка отчёта по продажам — зеркало SalesReportRow бэкенда. */
export interface SalesReportRow {
	dealId: number;
	category: string;
	/** Источник сделки (точка/склад оформления). */
	source: string;
	dateCreate: string;
	dateClosed: string;
	title: string;
	manager: string;
	goodsSum: number;
	worksSum: number;
	goodsProfit: number;
	worksProfit: number;
	goodsNoPurchase: number;
}

/** Собрать отчёт по продажам (сборка на бэкенде; фронтовый BX24 виснет на тяжёлых list/get). */
export async function fetchSalesReport(from: string, to: string, categoryIds: number[]): Promise<{ rows: SalesReportRow[]; coef: number }> {
	const res = await fetch('/api/reports/sales', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), from, to, categoryIds }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: SalesReportRow[]; coef?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось собрать отчёт');
	return { rows: json.rows ?? [], coef: json.coef ?? 0.5 };
}

// ── Реализации ↔ сделки (зеркало нативного списка + колонка «Сделка») ──────────

/** Строка реализации — зеркало RealizationRow бэкенда. */
export interface RealizationRow {
	shipmentId: number;
	orderId: number;
	/** Номер реализации, напр. «860/2». */
	account: string;
	date: string;
	responsible: string;
	sum: number;
	client: string;
	clientSub: string;
	/** Связанная сделка или null (заказ без crm_pr_). */
	deal: { id: number; title: string } | null;
}

/** Список реализаций со сделками (сборка на бэкенде; цепочка отгрузка→заказ→crm_pr_→сделка).
 *  from/to — YYYY-MM-DD, фильтр по дате проведения реализации (пусто = последние). */
export async function fetchRealizations(opts: { from?: string | undefined; to?: string | undefined; force?: boolean | undefined } = {}): Promise<{ rows: RealizationRow[]; generatedAt: string; truncated: boolean }> {
	const res = await fetch('/api/realizations/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), force: opts.force ?? false, from: opts.from, to: opts.to }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: RealizationRow[]; generatedAt?: string; truncated?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось собрать реализации');
	return { rows: json.rows ?? [], generatedAt: json.generatedAt ?? '', truncated: Boolean(json.truncated) };
}
