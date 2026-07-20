import { useEffect, useMemo, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchCurrentUserId,
	fetchDealCategories,
	fetchSalesReport,
	isPortalAdmin,
	withTimeout,
	MANAGEMENT_USER_IDS,
	type SalesReportRow,
} from './b24.js';

/**
 * Отчёт по продажам за период по менеджерам. Одна строка = выигранная сделка.
 * Вход: кнопка в «Базе товаров» (onBack) ИЛИ пункт меню списка сделок (placement, без onBack).
 * Сборка — на бэкенде (/api/reports/sales); тут период/воронки → превью + выгрузка CSV.
 *
 * Доступ к отчёту ограничен управленческими учётными записями.
 */

type Phase = { k: 'init' } | { k: 'denied' } | { k: 'ready' };

const CSV_HEADERS = [
	'Воронка',
	'Источник',
	'Дата создания',
	'Дата перевода в успех',
	'Название сделки',
	'ФИО менеджера',
	'Сумма товаров',
	'Сумма услуг',
	'Прибыльность товаров',
	'Прибыльность услуг',
	'Позиций без закупки',
];

const MOCK_ROWS: SalesReportRow[] = [
	{ dealId: 101, category: 'Быстрая продажа', source: 'Дунайский 64', dateCreate: '2026-06-01T10:00:00+03:00', dateClosed: '2026-06-03', title: 'Продажа камеры розница', manager: 'Галанов Сергей', goodsSum: 12000, worksSum: 0, goodsProfit: 4200, worksProfit: 0, goodsNoPurchase: 0 },
	{ dealId: 102, category: 'Объекты', source: 'Богатырский 15', dateCreate: '2026-05-20T12:30:00+03:00', dateClosed: '2026-06-04', title: 'Видеонаблюдение, склад на Пулковской', manager: 'Литвинов Алексей', goodsSum: 86000, worksSum: 45000, goodsProfit: 23000, worksProfit: 22500, goodsNoPurchase: 2 },
];

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}
function ymd(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** ISO/date Б24 → DD.MM.YYYY (для CSV/превью). */
function ruDate(s: string): string {
	if (!s) return '';
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
/** Число → строка с запятой-разделителем (ru Excel), 2 знака, без групп. */
function ruNum(n: number): string {
	return n.toFixed(2).replace('.', ',');
}
/** Экранирование поля CSV: оборачиваем в кавычки, если есть ; " или перевод строки. */
function csvCell(v: string): string {
	return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildCsv(rows: SalesReportRow[]): string {
	const lines = [CSV_HEADERS.join(';')];
	for (const r of rows) {
		lines.push([
			r.category,
			r.source,
			ruDate(r.dateCreate),
			ruDate(r.dateClosed),
			r.title,
			r.manager,
			ruNum(r.goodsSum),
			ruNum(r.worksSum),
			ruNum(r.goodsProfit),
			ruNum(r.worksProfit),
			String(r.goodsNoPurchase),
		].map((c) => csvCell(String(c))).join(';'));
	}
	// BOM — чтобы Excel открыл кириллицу в UTF-8.
	return '﻿' + lines.join('\r\n');
}

function downloadCsv(rows: SalesReportRow[], from: string, to: string): void {
	const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `Отчёт_продажи_${from}_${to}.csv`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SalesReport({ onBack }: { onBack?: (() => void) | undefined }): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [cats, setCats] = useState<{ id: number; name: string }[]>([]);
	const [pickedCats, setPickedCats] = useState<Set<number>>(() => new Set());

	const now = useMemo(() => new Date(), []);
	const [from, setFrom] = useState<string>(() => ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
	const [to, setTo] = useState<string>(() => ymd(now));

	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [rows, setRows] = useState<SalesReportRow[] | null>(null);

	useEffect(() => {
		if (ctx.__mock) {
			setPhase({ k: 'ready' });
			setCats([{ id: 0, name: 'Объекты' }, { id: 6, name: 'Быстрая продажа' }, { id: 2, name: 'Клиентская база' }]);
			return;
		}
		const bx = window.BX24;
		if (!bx) {
			setErr('BX24 SDK не загружен.');
			setPhase({ k: 'ready' });
			return;
		}
		bx.init(() => {
			void (async () => {
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!isPortalAdmin() && !MANAGEMENT_USER_IDS.includes(uid)) {
					setPhase({ k: 'denied' });
					return;
				}
				setPhase({ k: 'ready' });
				try {
					setCats(await withTimeout(fetchDealCategories(), 15000, 'crm.category.list'));
				} catch {
					setCats([]);
				}
			})().catch((e: unknown) => {
				setErr(String(e instanceof Error ? e.message : e));
				setPhase({ k: 'ready' });
			});
		});
	}, [ctx]);

	function toggleCat(id: number): void {
		setPickedCats((prev) => {
			const n = new Set(prev);
			if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
	}

	async function generate(): Promise<void> {
		setErr(null);
		setRows(null);
		if (from > to) {
			setErr('Дата «с» позже даты «по».');
			return;
		}
		setLoading(true);
		try {
			// пусто/все выбраны → [] (все воронки); иначе только выбранные
			const ids = pickedCats.size && pickedCats.size < cats.length ? [...pickedCats] : [];
			const data = ctx.__mock ? { rows: MOCK_ROWS } : await fetchSalesReport(from, to, ids);
			setRows(data.rows);
			if (data.rows.length) downloadCsv(data.rows, from, to);
		} catch (e: unknown) {
			setErr(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}

	if (phase.k === 'init') return <Shell onBack={onBack}><p>Загрузка…</p></Shell>;
	if (phase.k === 'denied') return <Shell onBack={onBack}><p className="stub-calm">Отчёт по продажам доступен руководителям. Если нужен доступ — напишите.</p></Shell>;

	return (
		<Shell onBack={onBack}>
			<>
				<div className="report-form">
					<label className="inv-field">Период с <input type="date" className="inv-date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
					<label className="inv-field">по <input type="date" className="inv-date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
					<span className="muted small">по дате перевода в успех</span>
				</div>

				{cats.length > 0 && (
					<div className="report-cats">
						<span className="muted">Воронки (ничего не выбрано = все):</span>
						<div className="report-cat-list">
							{cats.map((c) => (
								<label className="report-cat" key={c.id}>
									<input type="checkbox" checked={pickedCats.has(c.id)} onChange={() => toggleCat(c.id)} /> {c.name}
								</label>
							))}
						</div>
					</div>
				)}

				<div className="inv-actions">
					<button className="btn-primary" disabled={loading} onClick={() => void generate()}>
						{loading ? 'Собираю отчёт…' : '📊 Сформировать и скачать CSV'}
					</button>
					{rows && rows.length > 0 && (
						<button className="btn-secondary" onClick={() => downloadCsv(rows, from, to)}>↓ Скачать ещё раз</button>
					)}
				</div>

				{err && <p className="error">⛔ {err}</p>}
				{loading && <p className="muted">Тяну сделки за период, строки и закупки — на больших периодах это несколько секунд.</p>}

				{rows && (
					rows.length === 0
						? <p className="stub-calm">За период продаж не найдено.</p>
						: <ReportPreview rows={rows} />
				)}
			</>
		</Shell>
	);
}

function ReportPreview({ rows }: { rows: SalesReportRow[] }): JSX.Element {
	const PREVIEW = 50;
	const shown = rows.slice(0, PREVIEW);
	const num = (n: number): string => n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
	return (
		<div className="report-preview">
			<p className="report-count">✅ Готово: <b>{rows.length}</b> сделок. CSV скачан. {rows.length > PREVIEW ? `Ниже — первые ${PREVIEW} для проверки.` : 'Полный список ниже.'}</p>
			<div className="table-wrap">
				<table className="products-table report-table">
					<thead>
						<tr>
							<th>Воронка</th><th>Источник</th><th>Создана</th><th>Успех</th><th>Сделка</th><th>Менеджер</th>
							<th className="num">Товары</th><th className="num">Услуги</th><th className="num">Приб. тов.</th><th className="num">Приб. усл.</th><th className="num">Без зак.</th>
						</tr>
					</thead>
					<tbody>
						{shown.map((r) => (
							<tr key={r.dealId}>
								<td>{r.category}</td>
								<td>{r.source}</td>
								<td>{ruDate(r.dateCreate)}</td>
								<td>{ruDate(r.dateClosed)}</td>
								<td>{r.title}</td>
								<td>{r.manager}</td>
								<td className="num">{num(r.goodsSum)}</td>
								<td className="num">{num(r.worksSum)}</td>
								<td className="num">{num(r.goodsProfit)}</td>
								<td className="num">{num(r.worksProfit)}</td>
								<td className="num">{r.goodsNoPurchase || ''}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function Shell({ children, onBack }: { children: JSX.Element; onBack?: (() => void) | undefined }): JSX.Element {
	return (
		<div className="inv">
			{onBack && <div className="base-backbar"><button className="btn-secondary" onClick={onBack}>← База товаров</button></div>}
			<header>
				<h1>Отчёт по продажам</h1>
				<p className="subtitle">Выигранные сделки за период по менеджерам · выгрузка в CSV</p>
			</header>
			<section>{children}</section>
		</div>
	);
}
