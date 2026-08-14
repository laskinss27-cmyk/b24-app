import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import {
	deleteCustomReport,
	fetchReportBuilderBootstrap,
	runCustomReport,
	saveCustomReport,
	type ReportBuilderBootstrap,
	type ReportDataset,
	type ReportDefinition,
	type ReportField,
	type ReportRunResult,
	type SavedReport,
} from './report-builder-api.js';
import {
	activeReportResultFilterCount,
	filterReportResultRows,
	type ReportResultColumnFilter,
	type ReportResultFilters,
} from './report-result-filters.js';
import './ReportBuilder.css';

type Phase = 'loading' | 'ready' | 'denied';
type SaveMode = 'create' | 'rename' | null;

function isoDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function defaultPeriod(): { from: string; to: string } {
	const to = new Date();
	const from = new Date(to);
	from.setDate(from.getDate() - 59);
	return { from: isoDate(from), to: isoDate(to) };
}

function defaultDefinition(dataset: ReportDataset, period = defaultPeriod()): ReportDefinition {
	return {
		datasetId: dataset.id,
		columns: dataset.fields.filter((field) => field.defaultVisible).map((field) => field.id),
		groupBy: [],
		filters: period,
		sort: [],
	};
}

function cloneDefinition(value: ReportDefinition): ReportDefinition {
	return JSON.parse(JSON.stringify(value)) as ReportDefinition;
}

function sameDefinition(left: ReportDefinition, right: ReportDefinition): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

const MOCK_DATASETS: ReportDataset[] = [
	{
		id: 'sales_deals', name: 'Продажи по сделкам', description: 'Выигранные сделки и их финансовые показатели.', filters: ['period', 'categories'],
		fields: [
			{ id: 'category', label: 'Воронка', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'dateClosed', label: 'Дата продажи', type: 'date', role: 'dimension', defaultVisible: true },
			{ id: 'title', label: 'Сделка', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'manager', label: 'Менеджер', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'goodsSum', label: 'Продажа товаров', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'worksSum', label: 'Продажа работ', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'totalProfit', label: 'Общая прибыль', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: '__count', label: 'Количество сделок', type: 'number', role: 'measure', aggregate: 'sum' },
		],
	},
	{
		id: 'stock_turnover', name: 'Склад и оборачиваемость', description: 'Остатки, продажи и движение товаров по данным ядра.', filters: ['period', 'store'],
		fields: [
			{ id: 'article', label: 'Артикул', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'name', label: 'Товар', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'section', label: 'Категория', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'status', label: 'Состояние запаса', type: 'text', role: 'dimension', defaultVisible: true },
			{ id: 'currentQty', label: 'Текущий остаток', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'availableQty', label: 'Доступно', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'soldQty', label: 'Продано', type: 'number', role: 'measure', aggregate: 'sum', defaultVisible: true },
			{ id: 'daysOfStock', label: 'Запас на дней', type: 'number', role: 'measure', aggregate: 'average', defaultVisible: true },
			{ id: '__count', label: 'Количество товаров', type: 'number', role: 'measure', aggregate: 'sum' },
		],
	},
];

function mockBootstrap(): ReportBuilderBootstrap {
	return {
		user: { id: '1', name: 'Дранишников Владимир', isAdmin: true },
		datasets: MOCK_DATASETS,
		reports: [],
		options: { categories: [{ id: 0, name: 'Объекты' }, { id: 48, name: 'Умный дом' }], stores: ['Богатырский 15', 'Выборгское 503', 'Московский 131'] },
	};
}

function mockResult(dataset: ReportDataset, definition: ReportDefinition): ReportRunResult {
	const outputIds = [...new Set([...definition.groupBy, ...definition.columns])];
	const columns = outputIds.map((id) => dataset.fields.find((field) => field.id === id)).filter((field): field is ReportField => Boolean(field));
	const rows = dataset.id === 'sales_deals' ? [
		{ category: 'Умный дом', dateClosed: '2026-08-01', title: 'Домофония — объект на Литейном', manager: 'Иванов Алексей', goodsSum: 184500, worksSum: 42000, totalProfit: 68450, __count: 1 },
		{ category: 'Объекты', dateClosed: '2026-08-03', title: 'Видеонаблюдение — офис', manager: 'Петрова Анна', goodsSum: 97300, worksSum: 28000, totalProfit: 39120, __count: 1 },
	] : [
		{ article: 'CTV-M4108AI B', name: 'Видеодомофон 10″ Wi‑Fi', section: 'Домофония', status: 'normal', currentQty: 19, availableQty: 15, soldQty: 8, daysOfStock: 142, __count: 1 },
		{ article: 'DS-2CD2043G2-I', name: 'IP-камера 4 Мп', section: 'Видеонаблюдение', status: 'ending', currentQty: 3, availableQty: 2, soldQty: 12, daysOfStock: 9, __count: 1 },
	];
	return { columns, rows, totalRows: rows.length, truncated: false, generatedAt: new Date().toISOString() };
}

function formatCell(value: string | number | null, field: ReportField): string {
	if (value == null || value === '') return '—';
	if (field.type === 'number' && typeof value === 'number') return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
	const statuses: Record<string, string> = { ending: 'Заканчивается', ordered: 'Заказано', normal: 'Норма', excess: 'Избыток', no_movement: 'Без движения', no_stock: 'Нет в наличии' };
	return field.id === 'status' ? (statuses[String(value)] ?? String(value)) : String(value);
}

export function ReportBuilder({ embedded = false }: { embedded?: boolean }): JSX.Element {
	const ctx = getContext();
	const [phase, setPhase] = useState<Phase>('loading');
	const [bootstrap, setBootstrap] = useState<ReportBuilderBootstrap | null>(null);
	const [definition, setDefinition] = useState<ReportDefinition | null>(null);
	const [active, setActive] = useState<SavedReport | null>(null);
	const [result, setResult] = useState<ReportRunResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [saveMode, setSaveMode] = useState<SaveMode>(null);
	const [saveName, setSaveName] = useState('');
	const [resultFilters, setResultFilters] = useState<ReportResultFilters>({});

	useEffect(() => {
		const load = async (): Promise<void> => {
			try {
				const data = ctx.__mock ? mockBootstrap() : await fetchReportBuilderBootstrap();
				setBootstrap(data);
				const first = data.datasets[0];
				if (first) setDefinition(defaultDefinition(first));
				setPhase('ready');
			} catch (loadError) {
				const message = loadError instanceof Error ? loadError.message : String(loadError);
				if (/только администраторам|нет доступа/i.test(message)) setPhase('denied');
				else { setError(message); setPhase('ready'); }
			}
		};
		if (ctx.__mock) void load();
		else if (!window.BX24) { setError('BX24 SDK не загружен'); setPhase('ready'); }
		else window.BX24.init(() => { void load(); });
	}, [ctx.__mock]);

	const dataset = useMemo(() => bootstrap?.datasets.find((item) => item.id === definition?.datasetId) ?? null, [bootstrap, definition?.datasetId]);
	const dirty = Boolean(active && definition && !sameDefinition(active.definition, definition));
	const visibleResultRows = useMemo(() => result
		? filterReportResultRows(result.rows, result.columns, resultFilters, formatCell)
		: [], [result, resultFilters]);
	const activeResultFilters = activeReportResultFilterCount(resultFilters);

	function updateDefinition(update: (current: ReportDefinition) => ReportDefinition): void {
		setDefinition((current) => current ? update(current) : current);
		setResult(null);
		setError('');
	}

	function selectDataset(id: ReportDataset['id']): void {
		const nextDataset = bootstrap?.datasets.find((item) => item.id === id);
		if (!nextDataset || !definition) return;
		setDefinition(defaultDefinition(nextDataset, { from: definition.filters.from, to: definition.filters.to }));
		setActive(null);
		setResult(null);
	}

	function toggleColumn(field: ReportField): void {
		if (!definition) return;
		if (definition.groupBy.length && field.role === 'dimension' && !definition.groupBy.includes(field.id)) return;
		updateDefinition((current) => {
			const exists = current.columns.includes(field.id);
			if (exists && current.columns.length === 1) return current;
			return { ...current, columns: exists ? current.columns.filter((id) => id !== field.id) : [...current.columns, field.id] };
		});
	}

	function setGrouping(fieldId: string): void {
		updateDefinition((current) => {
			if (!fieldId) return { ...current, groupBy: [] };
			const measureIds = current.columns.filter((id) => dataset?.fields.find((field) => field.id === id)?.role === 'measure');
			return { ...current, groupBy: [fieldId], columns: [fieldId, ...measureIds] };
		});
	}

	function openReport(report: SavedReport): void {
		setActive(report);
		setDefinition(cloneDefinition(report.definition));
		setResult(null);
		setError('');
	}

	function newReport(): void {
		const first = bootstrap?.datasets[0];
		if (!first) return;
		setActive(null);
		setDefinition(defaultDefinition(first));
		setResult(null);
		setError('');
	}

	async function run(): Promise<void> {
		if (!definition || !dataset) return;
		setBusy(true); setError('');
		try {
			setResult(ctx.__mock ? mockResult(dataset, definition) : await runCustomReport(definition));
			setResultFilters({});
		} catch (runError) { setError(runError instanceof Error ? runError.message : String(runError)); }
		finally { setBusy(false); }
	}

	function patchResultFilter(fieldId: string, patch: Partial<ReportResultColumnFilter>): void {
		setResultFilters((current) => ({ ...current, [fieldId]: { ...current[fieldId], ...patch } }));
	}

	function replaceSaved(report: SavedReport): void {
		setBootstrap((current) => current ? { ...current, reports: [report, ...current.reports.filter((item) => item.id !== report.id)] } : current);
		setActive(report);
	}

	async function saveExisting(): Promise<void> {
		if (!active || !definition) { setSaveName('Новый отчёт'); setSaveMode('create'); return; }
		setBusy(true); setError('');
		try {
			const saved = ctx.__mock ? { ...active, definition: cloneDefinition(definition), updatedAt: new Date().toISOString() } : await saveCustomReport({ id: active.id, name: active.name, definition, expectedUpdatedAt: active.updatedAt });
			replaceSaved(saved);
		} catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); }
		finally { setBusy(false); }
	}

	async function confirmSave(): Promise<void> {
		if (!definition || !saveName.trim()) return;
		setBusy(true); setError('');
		try {
			let saved: SavedReport;
			if (saveMode === 'rename' && active) {
				saved = ctx.__mock ? { ...active, name: saveName.trim(), updatedAt: new Date().toISOString() } : await saveCustomReport({ id: active.id, name: saveName.trim(), definition: active.definition, expectedUpdatedAt: active.updatedAt });
				const currentDefinition = definition;
				replaceSaved(saved);
				setDefinition(currentDefinition);
			} else {
				const now = new Date().toISOString();
				saved = ctx.__mock ? { id: crypto.randomUUID(), name: saveName.trim(), definition: cloneDefinition(definition), createdAt: now, updatedAt: now } : await saveCustomReport({ name: saveName.trim(), definition });
				replaceSaved(saved);
			}
			setSaveMode(null);
		} catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); }
		finally { setBusy(false); }
	}

	async function removeActive(): Promise<void> {
		if (!active || !window.confirm(`Удалить личный отчёт «${active.name}»?`)) return;
		setBusy(true); setError('');
		try {
			if (!ctx.__mock) await deleteCustomReport(active.id);
			setBootstrap((current) => current ? { ...current, reports: current.reports.filter((report) => report.id !== active.id) } : current);
			newReport();
		} catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : String(deleteError)); }
		finally { setBusy(false); }
	}

	function exportCsv(): void {
		if (!result) return;
		const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
		const lines = [result.columns.map((column) => quote(column.label)).join(';'), ...visibleResultRows.map((row) => result.columns.map((column) => quote(formatCell(row[column.id] ?? null, column))).join(';'))];
		const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a'); link.href = url; link.download = `${active?.name ?? 'report'}.csv`; link.click(); URL.revokeObjectURL(url);
	}

	if (phase === 'loading') return <div className="rb-state">Открываем конструктор отчётов…</div>;
	if (phase === 'denied') return <div className="rb-state rb-denied"><h1>Нет доступа</h1><p>Раздел доступен только администраторам и Владимиру Дранишникову.</p></div>;
	if (!bootstrap || !definition || !dataset) return <div className="rb-state rb-denied"><h1>Конструктор не загрузился</h1><p>{error || 'Нет доступных источников данных.'}</p></div>;

	const grouped = definition.groupBy.length > 0;
	const selectedOutput = [...new Set([...definition.groupBy, ...definition.columns])];
	return <div className={`rb-app${embedded ? ' rb-embedded' : ''}`}>
		<header className="rb-topbar">
			<div><span className="rb-kicker">Умный дом · аналитика</span><h1>Конструктор отчётов</h1><p>Соберите форму один раз, затем меняйте период и выборку.</p></div>
			<div className="rb-user"><span>{bootstrap.user.name}</span><small>{bootstrap.user.isAdmin ? 'Администратор' : 'Персональный доступ'}</small></div>
		</header>
		<div className="rb-layout">
			<aside className="rb-sidebar">
				<button className="rb-button rb-primary rb-wide" onClick={newReport}>Новый отчёт</button>
				<div className="rb-sidebar-title">Мои отчёты <span>{bootstrap.reports.length}</span></div>
				<div className="rb-report-list">
					{bootstrap.reports.length === 0 && <p className="rb-empty-note">Здесь появятся ваши сохранённые формы.</p>}
					{bootstrap.reports.map((report) => <button key={report.id} className={active?.id === report.id ? 'active' : ''} onClick={() => openReport(report)}><strong>{report.name}</strong><small>{bootstrap.datasets.find((item) => item.id === report.definition.datasetId)?.name}</small></button>)}
				</div>
			</aside>

			<main className="rb-main">
				<section className="rb-card rb-title-card">
					<div><span className="rb-draft-label">{active ? 'Сохранённая форма' : 'Новая форма'}{dirty && ' · есть изменения'}</span><h2>{active?.name ?? 'Без названия'}</h2></div>
					<div className="rb-actions">
						{active && <button className="rb-button" onClick={() => { setSaveName(active.name); setSaveMode('rename'); }}>Переименовать</button>}
						{active && <button className="rb-button rb-danger" onClick={() => void removeActive()}>Удалить</button>}
						<button className="rb-button" onClick={() => { setSaveName(active ? `${active.name} — копия` : 'Новый отчёт'); setSaveMode('create'); }}>Сохранить как</button>
						<button className="rb-button rb-primary" disabled={busy} onClick={() => void saveExisting()}>Сохранить</button>
					</div>
				</section>

				{saveMode && <section className="rb-savebar"><label>{saveMode === 'rename' ? 'Новое название' : 'Название личного отчёта'}<input autoFocus value={saveName} maxLength={80} onChange={(event) => setSaveName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void confirmSave(); }} /></label><button className="rb-button rb-primary" disabled={!saveName.trim() || busy} onClick={() => void confirmSave()}>Готово</button><button className="rb-button" onClick={() => setSaveMode(null)}>Отмена</button></section>}

				{error && <div className="rb-error">{error}</div>}

				<section className="rb-card rb-settings">
					<div className="rb-section-head"><span>1</span><div><h3>Источник и выборка</h3><p>Исходные данные и период отчёта.</p></div></div>
					<div className="rb-form-grid">
						<label className="rb-span-2">Источник данных<select value={definition.datasetId} onChange={(event) => selectDataset(event.target.value as ReportDataset['id'])}>{bootstrap.datasets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{dataset.description}</small></label>
						<label>Период от<input type="date" value={definition.filters.from} onChange={(event) => updateDefinition((current) => ({ ...current, filters: { ...current.filters, from: event.target.value } }))} /></label>
						<label>Период до<input type="date" value={definition.filters.to} onChange={(event) => updateDefinition((current) => ({ ...current, filters: { ...current.filters, to: event.target.value } }))} /></label>
						{dataset.filters.includes('store') && <label className="rb-span-2">Склад<select value={definition.filters.store ?? ''} onChange={(event) => updateDefinition((current) => {
							const filters = { ...current.filters };
							if (event.target.value) filters.store = event.target.value; else delete filters.store;
							return { ...current, filters };
						})}><option value="">Все склады</option>{bootstrap.options.stores.map((store) => <option key={store}>{store}</option>)}</select></label>}
						{dataset.filters.includes('categories') && <label className="rb-span-2">Воронки сделок<select multiple value={(definition.filters.categoryIds ?? []).map(String)} onChange={(event) => { const categoryIds = [...event.currentTarget.selectedOptions].map((option) => Number(option.value)); updateDefinition((current) => ({ ...current, filters: { ...current.filters, categoryIds } })); }}>{bootstrap.options.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><small>Пустой выбор означает все воронки. Для нескольких используйте Ctrl.</small></label>}
					</div>
				</section>

				<section className="rb-card rb-settings">
					<div className="rb-section-head"><span>2</span><div><h3>Колонки</h3><p>Отметьте показатели, которые попадут в таблицу.</p></div></div>
					<div className="rb-field-groups">
						<div><h4>Измерения</h4><div className="rb-check-grid">{dataset.fields.filter((field) => field.role === 'dimension').map((field) => { const disabled = grouped && !definition.groupBy.includes(field.id); return <label key={field.id} className={disabled ? 'disabled' : ''}><input type="checkbox" checked={definition.columns.includes(field.id)} disabled={disabled} onChange={() => toggleColumn(field)} /><span>{field.label}</span></label>; })}</div></div>
						<div><h4>Показатели</h4><div className="rb-check-grid">{dataset.fields.filter((field) => field.role === 'measure').map((field) => <label key={field.id}><input type="checkbox" checked={definition.columns.includes(field.id)} onChange={() => toggleColumn(field)} /><span>{field.label}</span></label>)}</div></div>
					</div>
				</section>

				<section className="rb-card rb-settings">
					<div className="rb-section-head"><span>3</span><div><h3>Группировка и сортировка</h3><p>Например: одна строка на менеджера с суммами продаж.</p></div></div>
					<div className="rb-form-grid">
						<label>Группировать по<select value={definition.groupBy[0] ?? ''} onChange={(event) => setGrouping(event.target.value)}><option value="">Без группировки — подробные строки</option>{dataset.fields.filter((field) => field.role === 'dimension').map((field) => <option key={field.id} value={field.id}>{field.label}</option>)}</select></label>
						<label>Сортировать по<select value={definition.sort[0]?.field ?? ''} onChange={(event) => updateDefinition((current) => ({ ...current, sort: event.target.value ? [{ field: event.target.value, direction: current.sort[0]?.direction ?? 'asc' }] : [] }))}><option value="">Без сортировки</option>{selectedOutput.map((id) => { const field = dataset.fields.find((item) => item.id === id); return field ? <option key={id} value={id}>{field.label}</option> : null; })}</select></label>
						<label>Направление<select disabled={!definition.sort.length} value={definition.sort[0]?.direction ?? 'asc'} onChange={(event) => updateDefinition((current) => ({ ...current, sort: current.sort[0] ? [{ ...current.sort[0], direction: event.target.value as 'asc' | 'desc' }] : [] }))}><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></label>
					</div>
				</section>

				<div className="rb-runbar"><div><strong>{definition.columns.length}</strong> колонок{grouped ? ` · группировка «${dataset.fields.find((field) => field.id === definition.groupBy[0])?.label}»` : ' · подробный отчёт'}</div><button className="rb-button rb-primary rb-run" disabled={busy || !definition.columns.length} onClick={() => void run()}>{busy ? 'Строим…' : 'Построить отчёт'}</button></div>

				{result && <section className="rb-card rb-result">
					<div className="rb-result-head"><div><h3>Результат</h3><p>{activeResultFilters ? `${visibleResultRows.length} из ${result.rows.length} загруженных строк` : `${result.totalRows} строк`} · сформирован {new Date(result.generatedAt).toLocaleString('ru-RU')}</p></div><button className="rb-button" onClick={exportCsv}>Скачать CSV{activeResultFilters ? ` (${visibleResultRows.length})` : ''}</button></div>
					{result.truncated && <div className="rb-warning">Показаны первые 1000 строк. Уточните выборку или скачайте специализированный отчёт.</div>}
					<details className="rb-result-filters" open>
						<summary>Фильтры готового отчёта{activeResultFilters ? <b>{activeResultFilters}</b> : <small>без повторного построения</small>}</summary>
						<div className="rb-result-filter-body">
							<div className="rb-result-filter-actions"><span>Фильтры применяются одновременно и не меняют сохранённую форму отчёта.</span>{activeResultFilters > 0 && <button className="rb-button" type="button" onClick={() => setResultFilters({})}>Очистить все</button>}</div>
							<div className="rb-result-filter-grid">{result.columns.map((column) => {
								const filter = resultFilters[column.id] ?? {};
								return <label key={column.id}><span>{column.label}</span>{column.type === 'number'
									? <div><input type="number" step="any" placeholder="От" value={filter.min ?? ''} onChange={(event) => patchResultFilter(column.id, { min: event.target.value })} /><input type="number" step="any" placeholder="До" value={filter.max ?? ''} onChange={(event) => patchResultFilter(column.id, { max: event.target.value })} /></div>
									: column.type === 'date'
										? <div><input type="date" title="Дата от" value={filter.from ?? ''} onChange={(event) => patchResultFilter(column.id, { from: event.target.value })} /><input type="date" title="Дата до" value={filter.to ?? ''} onChange={(event) => patchResultFilter(column.id, { to: event.target.value })} /></div>
										: <input type="search" placeholder="Содержит…" value={filter.text ?? ''} onChange={(event) => patchResultFilter(column.id, { text: event.target.value })} />}</label>;
							})}</div>
						</div>
					</details>
					<div className="rb-table-wrap"><table><thead><tr>{result.columns.map((column) => <th key={column.id}>{column.label}</th>)}</tr></thead><tbody>{visibleResultRows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column.id} className={column.type === 'number' ? 'number' : ''}>{formatCell(row[column.id] ?? null, column)}</td>)}</tr>)}</tbody></table></div>
					{visibleResultRows.length === 0 && <div className="rb-empty-result">{activeResultFilters ? 'По заданным фильтрам строк не найдено.' : 'По выбранным условиям данных нет.'}</div>}
				</section>}
			</main>
		</div>
	</div>;
}
