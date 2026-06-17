/**
 * Read-only разведка под фичу «Отчёт по продажам за период по каждому менеджеру».
 *
 * Бьём DEV_WEBHOOK, НИЧЕГО не пишем. Цель — снять неизвестные перед дизайном отчёта:
 *   1) Воронки сделок (crm.category.list, entityTypeId=2) — сколько, какие.
 *   2) Стадии по воронкам (crm.status.list) + СЕМАНТИКА (что = «успех/продажа» S, провал F, в работе P).
 *   3) Менеджеры — активные пользователи (user.get): сколько, форма.
 *   4) Как тянутся сделки для отчёта: crm.deal.list — фильтры по ответственному/периоду/закрытию,
 *      какие поля дат (DATE_CREATE / BEGINDATE / CLOSEDATE / DATE_MODIFY), OPPORTUNITY, CATEGORY/STAGE.
 *   5) Объём: сколько всего сделок и сколько выигранных за последние ~90 дней (для скорости отчёта).
 *   6) Проба агрегации: выигранные за период → сгруппировать по ASSIGNED_BY_ID (кол-во + сумма).
 *
 * Запуск:  npx tsx scripts/recon-sales-report.ts
 * Вывод компактный — потом читаю и синтезирую, в git результат не коммитим.
 */

import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан в .env');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function hr(title: string): void {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}
function j(label: string, data: unknown): void {
	let s = JSON.stringify(data, null, 2);
	if (s && s.length > 3500) s = s.slice(0, 3500) + `\n…(обрезано, всего ${s.length} симв.)`;
	console.log(`${label}:\n${s}`);
}
async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		const msg = err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
		console.log(`  ⛔ ${method} → ${msg}`);
		return null;
	}
}
/** Тянем все страницы list-метода серверным start (вебхук уважает start). */
async function listAll(method: string, params: Record<string, unknown>, pluck: (d: unknown) => unknown[], cap = 2000): Promise<unknown[]> {
	const out: unknown[] = [];
	let start = 0;
	for (let i = 0; i < 60; i++) {
		const res = await tryCall<{ result?: unknown } | unknown>(method, { ...params, start });
		const page = pluck(res);
		out.push(...page);
		if (page.length < 50 || out.length >= cap) break;
		start += 50;
	}
	return out;
}

const daysAgoISO = (days: number): string => {
	// без Date.now() ограничений тут нет — это recon-скрипт, не workflow
	const d = new Date(Date.now() - days * 86400000);
	return d.toISOString().slice(0, 10);
};

async function main(): Promise<void> {
	// 1) Воронки сделок
	hr('1) ВОРОНКИ (crm.category.list entityTypeId=2)');
	const cats = await tryCall<{ categories?: Array<Record<string, unknown>> }>('crm.category.list', { entityTypeId: 2 });
	const categories = cats?.categories ?? [];
	j('воронки', categories.map((c) => ({ id: c['id'], name: c['name'], isDefault: c['isDefault'] })));

	// 2) Стадии + семантика
	hr('2) СТАДИИ + СЕМАНТИКА (crm.status.list ENTITY_ID LIKE DEAL_STAGE*)');
	const statuses = await listAll('crm.status.list', { filter: {}, order: { SORT: 'ASC' } }, (d) => (d as Array<unknown>) ?? []);
	const dealStages = (statuses as Array<Record<string, unknown>>).filter((s) => String(s['ENTITY_ID'] ?? '').startsWith('DEAL_STAGE'));
	j('стадии сделок (ENTITY_ID, STATUS_ID, NAME, SEMANTICS)', dealStages.map((s) => ({
		ENTITY_ID: s['ENTITY_ID'], STATUS_ID: s['STATUS_ID'], NAME: s['NAME'], SEMANTICS: s['SEMANTICS'],
	})));
	console.log('  (SEMANTICS: S=успех/продажа, F=провал, прочее/пусто=в работе)');

	// 3) Менеджеры
	hr('3) МЕНЕДЖЕРЫ (user.get ACTIVE=true)');
	const users = await listAll('user.get', { FILTER: { ACTIVE: true } }, (d) => (d as Array<unknown>) ?? [], 2000);
	console.log(`активных пользователей: ${users.length}`);
	j('пример (первые 5: ID, имя, должность, отдел)', (users as Array<Record<string, unknown>>).slice(0, 5).map((u) => ({
		ID: u['ID'], NAME: `${u['LAST_NAME'] ?? ''} ${u['NAME'] ?? ''}`.trim(), WORK_POSITION: u['WORK_POSITION'], UF_DEPARTMENT: u['UF_DEPARTMENT'],
	})));

	// 4) Поля сделки, относящиеся к отчёту
	hr('4) ПОЛЯ СДЕЛКИ для отчёта (crm.deal.fields — выборка)');
	const fields = await tryCall<Record<string, Record<string, unknown>>>('crm.deal.fields', {});
	if (fields) {
		const keys = ['ASSIGNED_BY_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'CLOSED', 'CLOSEDATE', 'BEGINDATE', 'DATE_CREATE', 'DATE_MODIFY', 'SOURCE_ID'];
		j('релевантные поля (тип, title)', Object.fromEntries(keys.map((k) => [k, fields[k] ? { type: fields[k]?.['type'], title: fields[k]?.['title'] } : 'НЕТ'])));
	}

	// 5) Объёмы
	hr('5) ОБЪЁМЫ (crm.deal.list — total)');
	const totalAll = await tryCall<{ total?: number }>('crm.deal.list', { filter: {}, select: ['ID'] });
	// total в B24Client.call теряется (возвращает result). Поэтому отдельно через сырой счёт первой страницы + ручной запрос total:
	const firstPage = await tryCall<Array<Record<string, unknown>>>('crm.deal.list', { filter: {}, select: ['ID'], start: 0 });
	console.log(`первая страница ID: ${firstPage?.length ?? 0} (total в обёртке не виден — оценим списком)`);
	void totalAll;

	const since = daysAgoISO(90);
	hr(`6) ВЫИГРАННЫЕ за 90 дней (с ${since}) — агрегация по менеджеру`);
	// фильтр: закрытые-успешно. Универсально через STAGE_SEMANTIC_ID='S' (если поле есть) + дата закрытия.
	const wonRaw = await listAll(
		'crm.deal.list',
		{ filter: { 'STAGE_SEMANTIC_ID': 'S', '>=CLOSEDATE': since }, select: ['ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'CATEGORY_ID', 'CLOSEDATE', 'CURRENCY_ID'], order: { CLOSEDATE: 'DESC' } },
		(d) => (d as Array<unknown>) ?? [],
		3000,
	);
	const won = wonRaw as Array<Record<string, unknown>>;
	console.log(`выигранных сделок за 90 дней: ${won.length}`);
	const byMgr = new Map<string, { count: number; sum: number }>();
	for (const dl of won) {
		const m = String(dl['ASSIGNED_BY_ID'] ?? '?');
		const e = byMgr.get(m) ?? { count: 0, sum: 0 };
		e.count++;
		e.sum += Number(dl['OPPORTUNITY'] ?? 0);
		byMgr.set(m, e);
	}
	const uName = new Map((users as Array<Record<string, unknown>>).map((u) => [String(u['ID']), `${u['LAST_NAME'] ?? ''} ${u['NAME'] ?? ''}`.trim()]));
	const agg = [...byMgr.entries()].map(([id, v]) => ({ manager: uName.get(id) ?? id, id, deals: v.count, sum: Math.round(v.sum) })).sort((a, b) => b.sum - a.sum);
	j('продажи по менеджерам (90 дней, выигранные)', agg.slice(0, 20));
	j('по воронкам выигранных (CATEGORY_ID → кол-во)', Object.entries(won.reduce<Record<string, number>>((acc, dl) => { const c = String(dl['CATEGORY_ID'] ?? '0'); acc[c] = (acc[c] ?? 0) + 1; return acc; }, {})));

	hr('ГОТОВО — разведка отчёта по продажам завершена');
}

main().catch((e) => {
	console.error('FATAL', e);
	process.exit(1);
});
