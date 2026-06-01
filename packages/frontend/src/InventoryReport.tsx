import { useEffect, useMemo, useState } from 'react';
import {
	fetchStoreInventory,
	fetchActLines,
	saveDraftPoint,
	submitPoint,
	photoFullUrl,
	searchProducts,
	buildAddedLine,
	type InvLine,
	type InvResult,
} from './b24.js';

/**
 * Экран подсчёта ОДНОЙ точки инвентаризации. Точка уже выбрана инициатором/менеджером
 * (приходит пропсами), поэтому здесь нет выбора склада и нет привязки к задаче.
 *
 * Опознание товара: Название · Артикул (property360) · Раздел; группировка по разделам;
 * поиск по названию И артикулу; тумблер фото (по умолчанию off — текст быстрее).
 * «Сохранить» → черновик (saveDraft), «Отправить» → финал (submit) — реальная запись в entity.
 */

interface InventoryCountProps {
	inventoryId: string;
	storeId: number;
	storeName: string;
	me: { id: string; name: string };
	/** Промежуточный подсчёт, если менеджер возвращается к черновику. */
	initialDraft?: Record<number, number> | undefined;
	/** Режим: обычный подсчёт или сверка акта разногласий (предзаполнено, другой заголовок). */
	mode?: 'count' | 'act' | undefined;
	/** Режим акта: показываем ТОЛЬКО эти расхождения 1-го раунда (с опознанием). */
	actLines?: InvResult['lines'] | undefined;
	/** Режим акта: размер инвентаризации 1-го раунда (для слияния в финал). */
	total1?: number | undefined;
	/** Охват (#13): считаем только эти разделы каталога; пусто/нет — весь склад. */
	sectionIds?: number[] | undefined;
	/** dev-режим (?inv) — берём мок вместо реального склада. */
	mock?: boolean | undefined;
	onBack: () => void;
	onSubmitted: (result: InvResult, facts: Record<number, number>) => void;
}

// dev-мок: дубли TS-AD различаются артикулом — показать, что строка их разводит
const MOCK_STOCK: Record<number, InvLine[]> = {
	8: [
		{ productId: 1, name: 'Аудиотрубка для видеодомофа TS-AD', book: 12, article: 'TS-AD', sectionName: 'Домофоны' },
		{ productId: 2, name: 'Аудиотрубка для видеодомофа TS-AD', book: 5, article: 'TS-AD Digital', sectionName: 'Домофоны' },
		{ productId: 3, name: 'IP видеокамера RL-IP14P-S.airXL', book: 8, article: 'RL-IP14P', sectionName: 'Камеры', manufacturer: 'Redline' },
		{ productId: 4, name: 'Источник питания на DIN рейку 24В HDR-30-24', book: 14, article: 'HDR-30-24', sectionName: 'Питание', manufacturer: 'Mean Well' },
		{ productId: 5, name: 'Гофротруба ПВХ 16 мм', book: 200, sectionName: 'Кабель и расходники' },
		{ productId: 6, name: 'Жёсткий диск HDD 8Tb', book: 7, article: 'HDD 8Tb', sectionName: 'Накопители' },
	],
	10: [
		{ productId: 11, name: 'Камера уличная IP 4Мп iFLOW', book: 6, sectionName: 'Камеры' },
		{ productId: 12, name: 'Розетка на DIN рейку РАр 10-3-ОП', book: 18, sectionName: 'Электрика' },
	],
};

export function InventoryCount(props: InventoryCountProps): JSX.Element {
	const { inventoryId, storeId, storeName, me, initialDraft, mode, actLines, total1, sectionIds, mock, onBack, onSubmitted } = props;

	const [items, setItems] = useState<InvLine[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [search, setSearch] = useState('');
	const [showPhotos, setShowPhotos] = useState(false);
	const [counts, setCounts] = useState<Record<number, string>>(() => {
		const o: Record<number, string> = {};
		if (initialDraft) for (const [k, v] of Object.entries(initialDraft)) o[Number(k)] = String(v);
		return o;
	});
	const [saving, setSaving] = useState(false);
	const [done, setDone] = useState<'draft' | 'sent' | null>(null);
	const [actionErr, setActionErr] = useState<string | null>(null);
	/** Вручную добавленные позиции (нет в остатках, физически есть) — учёт 0. */
	const [added, setAdded] = useState<InvLine[]>([]);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setLoadErr(null);
		// в режиме акта грузим ТОЛЬКО расхождения 1-го раунда (с опознанием), не весь склад
		const load: Promise<InvLine[]> =
			mode === 'act' && actLines
				? mock
					? Promise.resolve(actLines.map((l) => ({ productId: l.productId, name: l.name, book: l.book })))
					: fetchActLines(actLines)
				: mock
					? Promise.resolve(MOCK_STOCK[storeId] ?? [])
					: fetchStoreInventory(storeId, sectionIds);
		load
			.then((rows) => {
				if (!alive) return;
				setItems(rows);
				setAdded([]);
				// Восстановить вручную добавленные позиции из черновика: их productId есть в черновике,
				// но нет в текущих остатках (их там и не будет — учёт 0). Иначе при возврате к черновику терялись бы.
				if (mode !== 'act' && initialDraft) {
					const have = new Set(rows.map((r) => r.productId));
					const orphanIds = Object.keys(initialDraft).map(Number).filter((id) => id > 0 && !have.has(id));
					if (orphanIds.length) {
						void Promise.all(orphanIds.map((id) => buildAddedLine(id).catch(() => null))).then((ls) => {
							if (alive) setAdded(ls.filter((x): x is InvLine => x != null));
						});
					}
				}
			})
			.catch((e: unknown) => {
				if (alive) setLoadErr(String(e instanceof Error ? e.message : e));
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [storeId, mock, mode, actLines, sectionIds]);

	const list = useMemo<InvLine[]>(() => {
		const base = items ?? [];
		if (!added.length) return base;
		const have = new Set(base.map((i) => i.productId));
		return [...base, ...added.filter((a) => !have.has(a.productId))];
	}, [items, added]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return list;
		const words = q.split(/\s+/);
		return list.filter((i) => {
			const hay = `${i.name} ${i.article ?? ''} ${i.sectionName ?? ''}`.toLowerCase();
			return words.every((w) => hay.includes(w));
		});
	}, [list, search]);

	// группировка по разделу (раздел заполнен ~100% — удобная навигация при обходе)
	const groups = useMemo<Array<[string, InvLine[]]>>(() => {
		const addedIds = new Set(added.map((a) => a.productId));
		const addedRows = filtered.filter((i) => addedIds.has(i.productId));
		const baseRows = filtered.filter((i) => !addedIds.has(i.productId));
		const m = new Map<string, InvLine[]>();
		for (const i of baseRows) {
			const key = i.sectionName || 'Без раздела';
			const arr = m.get(key);
			if (arr) arr.push(i);
			else m.set(key, [i]);
		}
		const sectionGroups = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
		// добавленные вручную — отдельным блоком СВЕРХУ (легко найти среди сотен позиций)
		return addedRows.length ? [['➕ Добавленные вручную', addedRows], ...sectionGroups] : sectionGroups;
	}, [filtered, added]);

	const isCounted = (i: InvLine): boolean => {
		const v = counts[i.productId];
		return v !== undefined && v !== '';
	};
	const counted = list.filter(isCounted).length;
	const discrepancies = list.filter((i) => isCounted(i) && Number(counts[i.productId]) !== i.book).length;

	const draftObj = (): Record<number, number> => {
		const o: Record<number, number> = {};
		for (const i of list) {
			const v = counts[i.productId];
			if (v !== undefined && v !== '') o[i.productId] = Number(v);
		}
		return o;
	};

	async function onSave(): Promise<void> {
		setActionErr(null);
		if (mock) {
			setDone('draft');
			return;
		}
		setSaving(true);
		try {
			await saveDraftPoint(inventoryId, storeId, me.id, draftObj());
			setDone('draft');
		} catch (e: unknown) {
			setActionErr(String(e instanceof Error ? e.message : e));
		} finally {
			setSaving(false);
		}
	}

	async function onSubmit(): Promise<void> {
		setActionErr(null);
		// пустое поле = 0; расхождение считаем по ВСЕМ позициям (непосчитанное с учётом>0 = недостача)
		const factOf = (i: InvLine): number => {
			const v = counts[i.productId];
			return v === undefined || v === '' ? 0 : Number(v);
		};
		const lines: InvResult['lines'] = list
			.filter((i) => factOf(i) !== i.book)
			.map((i) => ({ productId: i.productId, name: i.name, book: i.book, fact: factOf(i), diff: factOf(i) - i.book }));
		// режим акта → слияние в финал: total и совпавшие берём из 1-го раунда, расхождения = оставшиеся после сверки
		const result: InvResult =
			mode === 'act'
				? { total: total1 ?? list.length, counted: (total1 ?? list.length) - lines.length, discrepancies: lines.length, lines }
				: { counted, total: list.length, discrepancies: lines.length, lines };
		const facts = draftObj(); // все факты раунда — чтобы предзаполнить 2-й раунд (акт)
		if (mock) {
			setDone('sent');
			setTimeout(() => onSubmitted(result, facts), 700);
			return;
		}
		setSaving(true);
		try {
			await submitPoint(inventoryId, storeId, me.id, me.name, result, facts);
			setDone('sent');
			setTimeout(() => onSubmitted(result, facts), 700);
		} catch (e: unknown) {
			setActionErr(String(e instanceof Error ? e.message : e));
		} finally {
			setSaving(false);
		}
	}

	async function addProduct(productId: number): Promise<void> {
		if (list.some((i) => i.productId === productId)) return;
		setActionErr(null);
		try {
			const line = await buildAddedLine(productId);
			setAdded((prev) => (prev.some((x) => x.productId === productId) ? prev : [...prev, line]));
		} catch (e: unknown) {
			setActionErr(String(e instanceof Error ? e.message : e));
		}
	}

	return (
		<div className="inv">
			<header>
				<h1>{mode === 'act' ? 'Акт разногласий' : 'Инвентаризация'} — {storeName}</h1>
				<p className="subtitle">
					{me.name} · посчитано {counted}/{list.length}
					{list.length - counted > 0 ? ` · не введено ${list.length - counted}` : ''} · расхождений {discrepancies} ·{' '}
					<button className="linklike" onClick={onBack}>
						← к точкам
					</button>
				</p>
			</header>

			{mock && <div className="dev-banner">dev-режим: остатки — мок.</div>}
			{mode === 'act' && (
				<div className="beta-banner">📝 Сверка акта разногласий: перепроверь спорные позиции, досчитай упущенное — затем «Отправить».</div>
			)}

			<div className="inv-toolbar">
				<input
					className="search"
					placeholder="🔎 поиск по названию или артикулу (TS-AD, камера, HDR…)"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					autoFocus
				/>
				<label className="photo-toggle">
					<input type="checkbox" checked={showPhotos} onChange={(e) => setShowPhotos(e.target.checked)} /> 🖼 Фото
				</label>
				<button className="btn-secondary print-btn" onClick={() => window.print()}>
					🖨 Печать
				</button>
			</div>

			{mode !== 'act' && !loading && !loadErr && (
				<AddProduct existingIds={new Set(list.map((i) => i.productId))} onAdd={(id) => void addProduct(id)} />
			)}

			{loading ? (
				<p>Загрузка остатков склада…</p>
			) : loadErr ? (
				<p className="error">⛔ {loadErr}</p>
			) : (
				<div className="count-list">
					{groups.map(([section, rows]) => (
						<div className={`count-group${section.startsWith('➕') ? ' added-group' : ''}`} key={section}>
							<div className="group-head">
								{section} <span className="group-count">{rows.length}</span>
							</div>
							{rows.map((i) => {
								const raw = counts[i.productId];
								const has = raw !== undefined && raw !== '';
								const diff = has ? Number(raw) - i.book : null;
								const cls = diff == null ? '' : diff === 0 ? 'ok' : diff < 0 ? 'short' : 'over';
								const photo = showPhotos && i.photoPath ? photoFullUrl(i.photoPath) : null;
								return (
									<div className="count-row" key={i.productId}>
										{showPhotos && (
											<div className="count-photo">{photo ? <img src={photo} alt="" loading="lazy" /> : <span className="no-photo">—</span>}</div>
										)}
										<div className="count-main">
											<div className="count-name">{i.name}</div>
											<div className="count-meta">
												{i.article && <span className="art">{i.article}</span>}
												{i.manufacturer && <span className="mf">{i.manufacturer}</span>}
											</div>
										</div>
										<div className="count-nums">
											<span className="book">учёт {i.book}</span>
											<input
												type="number"
												inputMode="numeric"
												min="0"
												className="count-input"
												value={raw ?? ''}
												onChange={(e) => setCounts((c) => ({ ...c, [i.productId]: e.target.value }))} onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
											/>
											<span className={`diff ${cls}`}>{diff == null ? '—' : diff > 0 ? `+${diff}` : diff}</span>
										</div>
									</div>
								);
							})}
						</div>
					))}
					{!filtered.length && <p className="empty">{list.length ? `Ничего не найдено по «${search}»` : 'На складе нет позиций'}</p>}
				</div>
			)}

			<div className="inv-actions sticky-actions">
				<button className="btn-secondary" disabled={saving || done === 'sent'} onClick={() => void onSave()}>
					{saving ? 'Сохраняю…' : 'Сохранить черновик'}
				</button>
				<button className="btn-primary" disabled={saving || done === 'sent' || !counted} onClick={() => void onSubmit()}>
					{saving ? 'Отправляю…' : 'Отправить отчёт'}
				</button>
				{done === 'draft' && <span className="hint ok">✅ Черновик сохранён — можно вернуться позже.</span>}
				{done === 'sent' && <span className="hint ok">✅ Отчёт отправлен.</span>}
				{actionErr && <span className="error">⛔ {actionErr}</span>}
			</div>

			<footer>
				<small>Артикул и раздел — для опознания (название в каталоге часто дублируется). Списание/оприходование по расхождениям — задел на потом.</small>
			</footer>
		</div>
	);
}

/** Поиск и добавление товара, которого нет в списке остатков (физически есть — учёт 0 → излишек). */
function AddProduct({ existingIds, onAdd }: { existingIds: Set<number>; onAdd: (id: number) => void }): JSX.Element {
	const [q, setQ] = useState('');
	const [results, setResults] = useState<{ id: number; name: string }[]>([]);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		const query = q.trim();
		if (query.length < 2) {
			setResults([]);
			return;
		}
		let alive = true;
		setBusy(true);
		searchProducts(query)
			.then((r) => {
				if (alive) setResults(r);
			})
			.catch(() => {
				if (alive) setResults([]);
			})
			.finally(() => {
				if (alive) setBusy(false);
			});
		return () => {
			alive = false;
		};
	}, [q]);
	const shown = results.filter((r) => !existingIds.has(r.id)).slice(0, 12);
	return (
		<div className="add-product">
			<div className="tag-input-wrap">
				<input
					className="inv-input"
					placeholder="➕ Нет в списке? Добавить товар — поиск по названию…"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				{shown.length > 0 && (
					<div className="tag-dropdown">
						{shown.map((o) => (
							<button
								type="button"
								className="tag-option"
								key={o.id}
								onMouseDown={(e) => {
									e.preventDefault();
									onAdd(o.id);
									setQ('');
									setResults([]);
								}}
							>
								{o.name}
							</button>
						))}
					</div>
				)}
			</div>
			{busy && <span className="muted small">ищу…</span>}
			{q.trim().length >= 2 && !busy && !shown.length && <span className="muted small">ничего не найдено</span>}
		</div>
	);
}
