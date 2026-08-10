import { useEffect, useState, type CSSProperties } from 'react';
import {
	downloadTurnoverReportXlsx, fetchTurnoverReport,
	type TurnoverReportRow, type TurnoverStatus,
} from './b24.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const fieldLabel: CSSProperties = { fontSize: 12, color: '#7a8699', display: 'block', margin: '8px 0 4px' };

const TURNOVER_STATUS: Record<TurnoverStatus, { label: string; color: string; bg: string }> = {
	ending: { label: 'Заканчивается', color: '#b42318', bg: '#fee4e2' },
	ordered: { label: 'Заканчивается, заказано', color: '#8a4b08', bg: '#fff1d6' },
	normal: { label: 'Норма', color: '#17603a', bg: '#dcfce7' },
	excess: { label: 'Избыток', color: '#6941c6', bg: '#eee8ff' },
	no_movement: { label: 'Нет движения', color: '#475467', bg: '#eef1f5' },
	no_stock: { label: 'Нет остатка', color: '#7a8699', bg: '#f5f6f8' },
};

const reportDate = (date: Date): string => {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
};

const qtyText = (qty: number): string => qty.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const moneyText = (value: number | null): string => value === null
	? 'нет данных'
	: `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

function TurnoverStatusBadge({ status }: { status: TurnoverStatus }): JSX.Element {
	const view = TURNOVER_STATUS[status];
	return <span style={{ display: 'inline-block', padding: '4px 7px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: view.color, background: view.bg, whiteSpace: 'nowrap' }}>{view.label}</span>;
}
/** Сводный отчёт снабженца: одна строка на товар, период свободный. */
export function TurnoverReportTab({ stores, mock = false }: { stores: string[]; mock?: boolean }): JSX.Element {
	const today = reportDate(new Date());
	const initialFrom = (() => { const date = new Date(); date.setDate(date.getDate() - 89); return reportDate(date); })();
	const [from, setFrom] = useState(initialFrom);
	const [to, setTo] = useState(today);
	const [store, setStore] = useState('');
	const [search, setSearch] = useState('');
	const [status, setStatus] = useState<TurnoverStatus | ''>('');
	const [section, setSection] = useState('');
	const [rows, setRows] = useState<TurnoverReportRow[]>([]);
	const [days, setDays] = useState(90);
	const [loading, setLoading] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [printing, setPrinting] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [page, setPage] = useState(1);
	const [costColumns, setCostColumns] = useState<{ average: boolean; total: boolean }>(() => {
		try {
			const saved = JSON.parse(window.localStorage.getItem('b24-turnover-cost-columns') ?? '') as { average?: unknown; total?: unknown };
			return { average: saved.average !== false, total: saved.total !== false };
		} catch {
			return { average: true, total: true };
		}
	});

	const load = async (): Promise<void> => {
		if (!from || !to) { setErr('Выбери обе даты.'); return; }
		if (from > to) { setErr('Дата «от» должна быть раньше даты «до».'); return; }
		setLoading(true); setErr(null); setPage(1);
		try {
			if (mock) {
				setRows([
					{ productId: 1042, name: 'IP-камера купольная 4 Мп', article: 'IPC-D42', brand: 'Tantos', section: 'Камеры', currentQty: 4, reservedQty: 3, orderedQty: 10, availableQty: 1, openingQty: 18, closingQty: 6, averageQty: 12, receivedQty: 10, soldQty: 22, returnedQty: 1, writtenOffQty: 0, turns: 1.83, dailySales: 0.244, daysOfStock: 4, averagePurchasePrice: 4850, stockValue: 19400, lastReceiptDate: from, lastSaleDate: to, status: 'ordered' },
					{ productId: 2050, name: 'Кабель UTP 5E, бухта', article: 'UTP-5E', brand: 'Rexant', section: 'Кабель', currentQty: 28, reservedQty: 4, orderedQty: 0, availableQty: 24, openingQty: 31, closingQty: 28, averageQty: 29.5, receivedQty: 5, soldQty: 8, returnedQty: 0, writtenOffQty: 0, turns: 0.27, dailySales: 0.089, daysOfStock: 270, averagePurchasePrice: 7200, stockValue: 201600, lastReceiptDate: from, lastSaleDate: to, status: 'excess' },
					{ productId: 3011, name: 'Блок питания 12В 3А', article: 'PS-12-3', brand: 'ST', section: 'Питание', currentQty: 12, reservedQty: 0, orderedQty: 0, availableQty: 12, openingQty: 12, closingQty: 12, averageQty: 12, receivedQty: 0, soldQty: 0, returnedQty: 0, writtenOffQty: 0, turns: 0, dailySales: 0, daysOfStock: null, averagePurchasePrice: null, stockValue: null, lastReceiptDate: '', lastSaleDate: '', status: 'no_movement' },
				]);
				setDays(Math.floor((Date.parse(`${to}T00:00:00`) - Date.parse(`${from}T00:00:00`)) / 86400000) + 1);
			} else {
				const result = await fetchTurnoverReport(from, to, store || undefined);
				setRows(result.rows); setDays(result.days);
			}
		} catch (e) { setErr(errText(e)); }
		finally { setLoading(false); }
	};

	useEffect(() => { void load(); /* первый отчёт за 90 дней */ // eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useEffect(() => {
		window.localStorage.setItem('b24-turnover-cost-columns', JSON.stringify(costColumns));
	}, [costColumns]);

	const sections = [...new Set(rows.map((row) => row.section).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
	const query = search.trim().toLocaleLowerCase('ru');
	const filtered = rows.filter((row) => {
		if (status && row.status !== status) return false;
		if (section && row.section !== section) return false;
		if (!query) return true;
		return `${row.name} ${row.productId} ${row.article} ${row.brand}`.toLocaleLowerCase('ru').includes(query);
	});
	const PAGE_SIZE = 100;
	const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	const summary = {
		sold: filtered.reduce((sum, row) => sum + row.soldQty, 0),
		received: filtered.reduce((sum, row) => sum + row.receivedQty, 0),
		ending: filtered.filter((row) => row.status === 'ending').length,
		noMovement: filtered.filter((row) => row.status === 'no_movement').length,
	};
	useEffect(() => {
		if (!printing) return;
		const clear = (): void => setPrinting(false);
		let fallback = 0;
		const frame = window.requestAnimationFrame(() => {
			window.print();
			fallback = window.setTimeout(clear, 1200);
		});
		window.addEventListener('afterprint', clear, { once: true });
		return () => {
			window.cancelAnimationFrame(frame);
			window.clearTimeout(fallback);
			window.removeEventListener('afterprint', clear);
		};
	}, [printing]);

	const downloadExcel = async (): Promise<void> => {
		setExporting(true); setErr(null);
		try {
			await downloadTurnoverReportXlsx({
				from, to,
				showAverageCost: costColumns.average,
				showStockValue: costColumns.total,
				...(store ? { store } : {}),
				...(search.trim() ? { search: search.trim() } : {}),
				...(status ? { status } : {}),
				...(section ? { section } : {}),
			});
		} catch (e) {
			setErr(errText(e));
		} finally {
			setExporting(false);
		}
	};

	return (
		<section>
			<div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginBottom: 12 }}>
				<label style={fieldLabel}>Дата от<input type="date" max={today} style={{ ...inp, display: 'block' }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
				<label style={fieldLabel}>Дата до<input type="date" max={today} style={{ ...inp, display: 'block' }} value={to} onChange={(e) => setTo(e.target.value)} /></label>
				<label style={fieldLabel}>Склад<select style={{ ...inp, display: 'block', minWidth: 180 }} value={store} onChange={(e) => setStore(e.target.value)}><option value="">Все склады</option>{stores.map((name) => <option key={name}>{name}</option>)}</select></label>
				<button className="btn-primary" disabled={loading} onClick={() => void load()}>{loading ? 'Считаю…' : 'Построить отчёт'}</button>
			</div>
			<p style={{ margin: '0 0 12px', fontSize: 12, color: '#7a8699' }}>Приход, расход и оборачиваемость — за выбранные {days} дн. Остаток, резерв и заказано — на сегодня. Перемещения между складами не считаются расходом.</p>
			{err && <p className="error">⛔ {err}</p>}
			{!err && <>
				<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
					{[
						['Позиций', qtyText(filtered.length)],
						['Реализовано', qtyText(summary.sold)],
						['Оприходовано', qtyText(summary.received)],
						['Заканчивается', qtyText(summary.ending)],
						['Без движения', qtyText(summary.noMovement)],
					].map(([label, value]) => <div key={label} style={{ padding: '10px 12px', border: '1px solid #e3e8ef', borderRadius: 8, background: '#fff' }}><div style={{ fontSize: 12, color: '#7a8699' }}>{label}</div><b style={{ fontSize: 18 }}>{value}</b></div>)}
				</div>
				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
					<input style={{ ...inp, flex: '1 1 250px' }} placeholder="🔎 товар, ID, артикул или бренд" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
					<select style={inp} value={status} onChange={(e) => { setStatus(e.target.value as TurnoverStatus | ''); setPage(1); }}>
						<option value="">Все состояния</option>
						{Object.entries(TURNOVER_STATUS).map(([key, view]) => <option key={key} value={key}>{view.label}</option>)}
					</select>
					<select style={inp} value={section} onChange={(e) => { setSection(e.target.value); setPage(1); }}><option value="">Все категории</option>{sections.map((name) => <option key={name}>{name}</option>)}</select>
					<button style={btnGhost} type="button" disabled={loading || !filtered.length} onClick={() => setPrinting(true)}>🖨 Печать</button>
					<button style={btnGhost} type="button" disabled={loading || exporting || !filtered.length} onClick={() => void downloadExcel()}>{exporting ? 'Готовлю Excel…' : '⬇ Excel'}</button>
					<details style={{ position: 'relative' }}>
						<summary style={{ ...btnGhost, listStyle: 'none', userSelect: 'none' }}>⚙ Колонки</summary>
						<div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 5, minWidth: 230, padding: 10, border: '1px solid #d0d5dd', borderRadius: 8, background: '#fff', boxShadow: '0 8px 24px rgba(16,24,40,.12)' }}>
							<label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}><input type="checkbox" checked={costColumns.average} onChange={(e) => setCostColumns((value) => ({ ...value, average: e.target.checked }))} />Средняя цена остатка</label>
							<label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={costColumns.total} onChange={(e) => setCostColumns((value) => ({ ...value, total: e.target.checked }))} />Стоимость остатка</label>
						</div>
					</details>
					<span style={{ fontSize: 12, color: '#7a8699', alignSelf: 'center' }}>Показано {shown.length} из {filtered.length}</span>
				</div>
				{!loading && !filtered.length ? <p className="empty">По выбранным условиям позиций нет.</p> : (
					<div style={{ overflowX: 'auto', border: '1px solid #e3e8ef', borderRadius: 8 }}>
						<table style={{ width: '100%', minWidth: 1320, borderCollapse: 'collapse', background: '#fff' }}>
							<thead><tr>
								<th style={TH}>Товар</th><th style={TH}>Состояние</th><th style={TH}>Начало → конец<br />средний</th>
								<th style={TH}>Приход</th><th style={TH}>Реализация<br />возврат</th><th style={TH}>Списано</th>
								<th style={TH}>Оборотов</th><th style={TH}>Запас, дней</th><th style={TH}>Сегодня<br />остаток / свободно</th>
								{costColumns.average && <th style={TH} title="Средняя текущая оценка фактически лежащего товара по данным ERPNext">Средняя цена<br />остатка</th>}
								{costColumns.total && <th style={TH} title="Оценочная стоимость фактически лежащего товара по данным ERPNext">Стоимость<br />остатка</th>}
								<th style={TH}>Резерв</th><th style={TH}>Заказано</th><th style={TH}>Последние движения</th>
							</tr></thead>
							<tbody>{shown.map((row) => <tr key={row.productId}>
								<td style={{ ...TD, minWidth: 250 }}><b>{row.name}</b><div style={{ color: '#7a8699', fontSize: 12 }}>#{row.productId}{row.article ? ` · ${row.article}` : ''}{row.brand ? ` · ${row.brand}` : ''}</div>{row.section && <div style={{ color: '#98a2b3', fontSize: 11 }}>{row.section}</div>}</td>
								<td style={TD}><TurnoverStatusBadge status={row.status} /></td>
								<td style={TD}>{qtyText(row.openingQty)} → {qtyText(row.closingQty)}<div style={{ color: '#7a8699', fontSize: 12 }}>ср. {qtyText(row.averageQty)}</div></td>
								<td style={{ ...TD, color: '#17603a', fontWeight: 600 }}>+{qtyText(row.receivedQty)}</td>
								<td style={TD}><b>{qtyText(row.soldQty)}</b>{row.returnedQty > 0 && <div style={{ color: '#7a8699', fontSize: 12 }}>возврат {qtyText(row.returnedQty)}</div>}</td>
								<td style={TD}>{qtyText(row.writtenOffQty)}</td>
								<td style={TD}>{row.turns === null ? '—' : qtyText(row.turns)}</td>
								<td style={TD}>{row.daysOfStock === null ? '—' : qtyText(row.daysOfStock)}</td>
								<td style={TD}><b>{qtyText(row.currentQty)}</b><div style={{ color: row.availableQty <= 0 ? '#b42318' : '#7a8699', fontSize: 12 }}>своб. {qtyText(row.availableQty)}</div></td>
								{costColumns.average && <td style={{ ...TD, whiteSpace: 'nowrap', color: row.averagePurchasePrice === null ? '#98a2b3' : '#1a2231' }}>{moneyText(row.averagePurchasePrice)}</td>}
								{costColumns.total && <td style={{ ...TD, whiteSpace: 'nowrap', color: row.stockValue === null ? '#98a2b3' : '#1a2231' }}>{moneyText(row.stockValue)}</td>}
								<td style={TD}>{qtyText(row.reservedQty)}</td>
								<td style={TD}>{qtyText(row.orderedQty)}</td>
								<td style={{ ...TD, fontSize: 12 }}><div>приход: {row.lastReceiptDate || '—'}</div><div>продажа: {row.lastSaleDate || '—'}</div></td>
							</tr>)}</tbody>
						</table>
					</div>
				)}
				{pages > 1 && <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginTop: 12 }}><button style={btnGhost} disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>←</button><span style={{ fontSize: 13 }}>Страница {page} из {pages}</span><button style={btnGhost} disabled={page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}>→</button></div>}
			</>}
			{printing && <>
				<style media="print">{'@page { size: A4 landscape; margin: 8mm; }'}</style>
				<div className="turnover-print">
					<header>
						<div><span>Снабжение · Отчёт</span><h1>Оборачиваемость товаров</h1></div>
						<div className="turnover-print-period"><span>Период</span><b>{from} — {to}</b><small>{store || 'Все склады'}</small></div>
					</header>
					<div className="turnover-print-filters">
						<span>Позиций: <b>{filtered.length}</b></span>
						<span>Оприходовано: <b>{qtyText(summary.received)}</b></span>
						<span>Реализовано: <b>{qtyText(summary.sold)}</b></span>
						{status && <span>Состояние: <b>{TURNOVER_STATUS[status].label}</b></span>}
						{section && <span>Категория: <b>{section}</b></span>}
						{search.trim() && <span>Поиск: <b>{search.trim()}</b></span>}
					</div>
					<table>
						<thead><tr>
							<th>№</th><th>Товар</th><th>Состояние</th><th>Начало → конец<br />средний</th>
							<th>Приход</th><th>Реализовано<br />возврат</th><th>Списано</th><th>Оборотов</th>
							<th>Запас,<br />дней</th><th>Остаток<br />свободно</th>
							{costColumns.average && <th>Средняя цена<br />остатка</th>}
							{costColumns.total && <th>Стоимость<br />остатка</th>}
							<th>Резерв</th><th>Заказано</th>
						</tr></thead>
						<tbody>{filtered.map((row, index) => <tr key={row.productId}>
							<td className="num">{index + 1}</td>
							<td><b>{row.name}</b><small>#{row.productId}{row.article ? ` · ${row.article}` : ''}{row.brand ? ` · ${row.brand}` : ''}</small></td>
							<td>{TURNOVER_STATUS[row.status].label}</td>
							<td className="num">{qtyText(row.openingQty)} → {qtyText(row.closingQty)}<small>ср. {qtyText(row.averageQty)}</small></td>
							<td className="num">{qtyText(row.receivedQty)}</td>
							<td className="num">{qtyText(row.soldQty)}<small>возврат {qtyText(row.returnedQty)}</small></td>
							<td className="num">{qtyText(row.writtenOffQty)}</td>
							<td className="num">{row.turns === null ? '—' : qtyText(row.turns)}</td>
							<td className="num">{row.daysOfStock === null ? '—' : qtyText(row.daysOfStock)}</td>
							<td className="num">{qtyText(row.currentQty)}<small>своб. {qtyText(row.availableQty)}</small></td>
							{costColumns.average && <td className="num">{moneyText(row.averagePurchasePrice)}</td>}
							{costColumns.total && <td className="num">{moneyText(row.stockValue)}</td>}
							<td className="num">{qtyText(row.reservedQty)}</td>
							<td className="num">{qtyText(row.orderedQty)}</td>
						</tr>)}</tbody>
					</table>
					<footer>Перемещения между складами не считаются расходом. Реализация указана за вычетом возвратов. Текущие остатки и стоимость — на момент формирования.</footer>
				</div>
			</>}
		</section>
	);
}
