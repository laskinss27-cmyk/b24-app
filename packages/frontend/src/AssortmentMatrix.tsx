import { useEffect, useMemo, useState } from 'react';
import {
	fetchAssortmentMatrix,
	saveAssortmentMatrixItem,
	searchStockItems,
	type AssortmentMatrixReport,
	type AssortmentMatrixRow,
	type AssortmentMatrixSalesScope,
	type StockItem,
} from './b24.js';

const STORE_KEY = 'b24-assortment-matrix-stores-v1';
const SALES_SCOPE_KEY = 'b24-assortment-matrix-sales-scope-v1';

const dateText = (date: Date): string => {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
};
const qty = (value: number): string => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface RowDraft { category: string; segment: string; toOrder: string; comment: string }

const mockReport = (stores: string[]): AssortmentMatrixReport => ({
	stores,
	selectedStores: stores,
	categories: ['Домофония', 'Видеонаблюдение'],
	salesScope: 'selected',
	periodDays: 90,
	targetDays: 60,
	generatedAt: new Date().toISOString(),
	rows: [
		{ productId: 111139, name: 'CTV-M4108Ai B', article: '', model: 'CTV-M4108Ai B', brand: 'CTV', category: 'Домофония', segment: 'Видеодомофон 7 дюймов без вайфай', stocks: Object.fromEntries(stores.map((store, index) => [store, index ? 1 : 0])), totalStock: Math.max(stores.length - 1, 0), reservedQty: 0, freeQty: Math.max(stores.length - 1, 0), orderedQty: 0, soldQty: 3, recommendedQty: 1, toOrderQty: 7, comment: '' },
		{ productId: 111125, name: 'CTV-M3713 Astra Plus B', article: '', model: 'CTV-M3713 Astra Plus B', brand: 'CTV', category: 'Домофония', segment: 'Видеодомофон 7 дюймов без вайфай', stocks: Object.fromEntries(stores.map((store, index) => [store, index + 1])), totalStock: stores.reduce((sum, _store, index) => sum + index + 1, 0), reservedQty: 2, freeQty: Math.max(stores.reduce((sum, _store, index) => sum + index + 1, 0) - 2, 0), orderedQty: 0, soldQty: 8, recommendedQty: 0, toOrderQty: 15, comment: 'Проверить доступность' },
	],
});

export function AssortmentMatrix({ stores: initialStores, mock = false }: { stores: string[]; mock?: boolean }): JSX.Element {
	const today = dateText(new Date());
	const initialFrom = (() => { const date = new Date(); date.setDate(date.getDate() - 89); return dateText(date); })();
	const [from, setFrom] = useState(initialFrom);
	const [to, setTo] = useState(today);
	const [selectedStores, setSelectedStores] = useState<string[]>(() => {
		try {
			const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? '[]') as unknown;
			if (Array.isArray(saved)) {
				const valid = saved.map(String).filter((store) => initialStores.includes(store));
				if (valid.length) return valid;
			}
		} catch { /* используем все склады */ }
		return initialStores;
	});
	const [salesScope, setSalesScope] = useState<AssortmentMatrixSalesScope>(() =>
		window.localStorage.getItem(SALES_SCOPE_KEY) === 'all' ? 'all' : 'selected');
	const [report, setReport] = useState<AssortmentMatrixReport | null>(mock ? mockReport(initialStores) : null);
	const [drafts, setDrafts] = useState<Record<number, RowDraft>>({});
	const [loading, setLoading] = useState(!mock);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState<number | null>(null);
	const [search, setSearch] = useState('');
	const [results, setResults] = useState<StockItem[]>([]);
	const [searching, setSearching] = useState(false);
	const [picked, setPicked] = useState<StockItem | null>(null);
	const [addCategory, setAddCategory] = useState('');
	const [addSegment, setAddSegment] = useState('');
	const [filter, setFilter] = useState('');

	const syncDrafts = (rows: AssortmentMatrixRow[]): void => setDrafts(Object.fromEntries(rows.map((row) => [row.productId, {
		category: row.category,
		segment: row.segment,
		toOrder: String(row.toOrderQty),
		comment: row.comment,
	}])));

	const load = async (): Promise<void> => {
		if (!from || !to || from > to) { setError('Проверь период отчёта.'); return; }
		if (!selectedStores.length) { setError('Выбери хотя бы один склад.'); return; }
		setLoading(true); setError('');
		try {
			const next = mock ? mockReport(selectedStores) : await fetchAssortmentMatrix({ from, to, selectedStores, salesScope });
			setReport(next);
			setSelectedStores(next.selectedStores);
			syncDrafts(next.rows);
			window.localStorage.setItem(STORE_KEY, JSON.stringify(next.selectedStores));
			window.localStorage.setItem(SALES_SCOPE_KEY, salesScope);
		} catch (reason) { setError(errorText(reason)); }
		finally { setLoading(false); }
	};

	useEffect(() => {
		if (!selectedStores.length && initialStores.length) setSelectedStores(initialStores);
	}, [initialStores, selectedStores.length]);
	useEffect(() => {
		if (mock) { syncDrafts(mockReport(initialStores).rows); return; }
		if (selectedStores.length) void load();
		// Первый отчёт строим один раз после появления списка складов.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialStores.length]);

	const categories = useMemo(() => [...new Set([
		...(report?.categories ?? []),
		...(report?.rows.map((row) => row.category) ?? []),
	].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [report]);
	const segments = useMemo(() => [...new Set((report?.rows ?? [])
		.filter((row) => !addCategory || row.category === addCategory)
		.map((row) => row.segment).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [addCategory, report]);
	const visibleRows = useMemo(() => {
		const query = filter.trim().toLocaleLowerCase('ru');
		if (!query) return report?.rows ?? [];
		return (report?.rows ?? []).filter((row) => `${row.category} ${row.segment} ${row.productId} ${row.name} ${row.model} ${row.article} ${row.comment}`.toLocaleLowerCase('ru').includes(query));
	}, [filter, report]);

	const patchDraft = (productId: number, patch: Partial<RowDraft>): void => setDrafts((current) => ({
		...current,
		[productId]: { ...(current[productId] ?? { category: '', segment: '', toOrder: '0', comment: '' }), ...patch },
	}));

	const saveRow = async (row: AssortmentMatrixRow): Promise<void> => {
		const draft = drafts[row.productId];
		if (!draft) return;
		setSaving(row.productId); setError('');
		try {
			const toOrderQty = Number(draft.toOrder.replace(',', '.'));
			if (mock) await Promise.resolve();
			else await saveAssortmentMatrixItem({ productId: row.productId, enabled: true, category: draft.category, segment: draft.segment, toOrderQty, comment: draft.comment });
			setReport((current) => current ? { ...current, rows: current.rows.map((item) => item.productId === row.productId ? { ...item, category: draft.category.trim(), segment: draft.segment.trim(), toOrderQty, comment: draft.comment.trim() } : item).sort((left, right) => left.category.localeCompare(right.category, 'ru') || left.segment.localeCompare(right.segment, 'ru') || left.name.localeCompare(right.name, 'ru')) } : current);
		} catch (reason) { setError(errorText(reason)); }
		finally { setSaving(null); }
	};

	const removeRow = async (row: AssortmentMatrixRow): Promise<void> => {
		if (!window.confirm(`Убрать «${row.name}» из матрицы? Сам товар останется в каталоге.`)) return;
		setSaving(row.productId); setError('');
		try {
			if (!mock) await saveAssortmentMatrixItem({ productId: row.productId, enabled: false, category: row.category, segment: row.segment, toOrderQty: row.toOrderQty, comment: row.comment });
			setReport((current) => current ? { ...current, rows: current.rows.filter((item) => item.productId !== row.productId) } : current);
		} catch (reason) { setError(errorText(reason)); }
		finally { setSaving(null); }
	};

	const findProducts = async (): Promise<void> => {
		if (!search.trim()) return;
		setSearching(true); setError('');
		try {
			const found = mock
				? [{ productId: 112000, name: `Тестовый товар ${search.trim()}`, article: '', brand: '', stocks: {}, total: 0 }]
				: await searchStockItems(search);
			const used = new Set(report?.rows.map((row) => row.productId));
			setResults(found.filter((item) => !used.has(item.productId)));
		} catch (reason) { setError(errorText(reason)); }
		finally { setSearching(false); }
	};

	const addProduct = async (): Promise<void> => {
		if (!picked || !addCategory || !addSegment.trim()) { setError('Выбери категорию, сегмент и товар.'); return; }
		setSaving(picked.productId); setError('');
		try {
			if (!mock) await saveAssortmentMatrixItem({ productId: picked.productId, enabled: true, category: addCategory, segment: addSegment, toOrderQty: 0, comment: '' });
			setPicked(null); setSearch(''); setResults([]);
			await load();
		} catch (reason) { setError(errorText(reason)); }
		finally { setSaving(null); }
	};

	return <section className="assortment-matrix">
		<div className="assortment-matrix-banner"><b>Канарейка</b><span>Матрица видна только Сергею #1858. Рекомендация рассчитывается на явный запас <strong>60 дней</strong>.</span></div>
		<div className="assortment-matrix-filters">
			<label>Продажи с<input type="date" max={today} value={from} onChange={(event) => setFrom(event.target.value)} /></label>
			<label>по<input type="date" max={today} value={to} onChange={(event) => setTo(event.target.value)} /></label>
			<label>Продажи считать<select value={salesScope} onChange={(event) => setSalesScope(event.target.value as AssortmentMatrixSalesScope)}><option value="selected">По выбранным складам</option><option value="all">По всем складам</option></select></label>
			<details className="assortment-matrix-stores"><summary>Склады в расчёте: {selectedStores.length}</summary><div><button type="button" onClick={() => setSelectedStores(report?.stores ?? initialStores)}>Выбрать все</button>{(report?.stores ?? initialStores).map((store) => <label key={store}><input type="checkbox" checked={selectedStores.includes(store)} onChange={(event) => setSelectedStores((current) => event.target.checked ? [...new Set([...current, store])] : current.filter((item) => item !== store))} />{store}</label>)}</div></details>
			<button className="btn-primary" type="button" disabled={loading} onClick={() => void load()}>{loading ? 'Считаю…' : 'Построить'}</button>
		</div>
		<p className="assortment-matrix-note">Общий остаток считается только по выведенным складам. Рекомендация: продажи в день × 60 дней − свободный остаток − уже заказано поставщикам.</p>

		<div className="assortment-matrix-add">
			<select value={addCategory} onChange={(event) => setAddCategory(event.target.value)}><option value="">Категория</option>{categories.map((category) => <option key={category}>{category}</option>)}</select>
			<input list="assortment-matrix-segments" value={addSegment} placeholder="Сегмент товара" onChange={(event) => setAddSegment(event.target.value)} />
			<datalist id="assortment-matrix-segments">{segments.map((segment) => <option key={segment} value={segment} />)}</datalist>
			<div className="assortment-matrix-search"><input value={search} placeholder="ID, модель или название товара" onChange={(event) => { setSearch(event.target.value); setPicked(null); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void findProducts(); } }} /><button type="button" disabled={searching} onClick={() => void findProducts()}>{searching ? '…' : 'Найти'}</button>{results.length > 0 && <div>{results.map((item) => <button key={item.productId} type="button" className={picked?.productId === item.productId ? 'picked' : ''} onClick={() => { setPicked(item); setSearch(item.name); setResults([]); }}>{item.name}<small>#{item.productId}{item.article ? ` · ${item.article}` : ''}</small></button>)}</div>}</div>
			<button className="btn-primary" type="button" disabled={!picked || saving !== null} onClick={() => void addProduct()}>+ Добавить товар</button>
		</div>

		{error && <p className="error">⛔ {error}</p>}
		<div className="assortment-matrix-toolbar"><input type="search" placeholder="Поиск по матрице" value={filter} onChange={(event) => setFilter(event.target.value)} /><span>{visibleRows.length} позиций · анализ {report?.periodDays ?? 0} дней · целевой запас {report?.targetDays ?? 60} дней</span></div>
		<div className="assortment-matrix-table-wrap"><table><thead><tr><th>Категория</th><th>Сегментация товара</th><th>ID или модель товара</th>{selectedStores.map((store) => <th key={store}>{store}</th>)}<th>Общие остатки</th><th>Продажи за период</th><th>Рекомендовано к заказу<br /><small>запас на 60 дней</small></th><th>К заказу</th><th>Комментарий</th><th /></tr></thead><tbody>
			{visibleRows.map((row) => {
				const draft = drafts[row.productId] ?? { category: row.category, segment: row.segment, toOrder: String(row.toOrderQty), comment: row.comment };
				return <tr key={row.productId}>
					<td><select value={draft.category} onChange={(event) => patchDraft(row.productId, { category: event.target.value })}>{[...new Set([draft.category, ...categories])].filter(Boolean).map((category) => <option key={category}>{category}</option>)}</select></td>
					<td><input value={draft.segment} onChange={(event) => patchDraft(row.productId, { segment: event.target.value })} /></td>
					<td className="assortment-matrix-product"><b>{row.model || row.name}</b><small>#{row.productId}{row.article ? ` · ${row.article}` : ''}{row.model && row.name !== row.model ? ` · ${row.name}` : ''}</small></td>
					{selectedStores.map((store) => <td key={store} className={(row.stocks[store] ?? 0) <= 0 ? 'zero' : 'number'}>{qty(row.stocks[store] ?? 0)}</td>)}
					<td className={row.totalStock <= 0 ? 'zero total' : 'number total'} title={`Свободно ${qty(row.freeQty)}; резерв ${qty(row.reservedQty)}`}>{qty(row.totalStock)}</td>
					<td className={row.soldQty <= 0 ? 'zero sales' : 'number sales'}>{qty(row.soldQty)}</td>
					<td className="number recommended" title={`Продажи ${qty(row.soldQty)} / ${report?.periodDays ?? 0} дней × 60 − свободно ${qty(row.freeQty)} − заказано ${qty(row.orderedQty)}`}>{qty(row.recommendedQty)}<small>своб. {qty(row.freeQty)} · заказано {qty(row.orderedQty)}</small></td>
					<td><input className="number-input" type="number" min="0" step="any" value={draft.toOrder} onChange={(event) => patchDraft(row.productId, { toOrder: event.target.value })} /></td>
					<td><textarea rows={2} value={draft.comment} onChange={(event) => patchDraft(row.productId, { comment: event.target.value })} /></td>
					<td className="assortment-matrix-actions"><button type="button" disabled={saving !== null} onClick={() => void saveRow(row)}>{saving === row.productId ? '…' : 'Сохранить'}</button><button type="button" className="danger" disabled={saving !== null} onClick={() => void removeRow(row)}>Убрать</button></td>
				</tr>;
			})}
			{!loading && visibleRows.length === 0 && <tr><td colSpan={10 + selectedStores.length} className="assortment-matrix-empty">Добавь первые товары в матрицу.</td></tr>}
		</tbody></table></div>
	</section>;
}
