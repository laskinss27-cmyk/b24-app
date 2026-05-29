import { useEffect, useMemo, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { fetchStores, fetchStoreInventory, fetchCurrentUserId, BETA_USER_IDS, type InvLine } from './b24.js';

/**
 * Отчёт инвентаризации. Открывается из кнопки «Приступить» в задаче (placement
 * TASK_VIEW_TOP_PANEL). Точки — catalog.store.list, учётные остатки —
 * catalog.storeproduct.list по складу. Всё ЧТЕНИЕ; «Сохранить»/«Отправить»
 * пока заглушки (запись в задачу/на Диск — следующая фаза).
 *
 * Процесс: привязки менеджер→точка нет → менеджер сам выбирает точку → считает
 * с обязательным поиском → Сохранить (черновик) / Отправить (финал).
 *
 * Канарейка: реальный отчёт видит только Сергей (BETA_USER_IDS); остальные —
 * спокойная заглушка.
 */

interface Point {
	storeId: number;
	title: string;
}

// мок для локального превью (?inv): «каша» камер — показать поиск
const MOCK_POINTS: Point[] = [
	{ storeId: 8, title: 'Максидом Дунайский 64' },
	{ storeId: 10, title: 'Максидом Богатырский 15' },
	{ storeId: 22, title: 'Максидом Фаворского 12' },
];
const MOCK_STOCK: Record<number, InvLine[]> = {
	8: [
		{ productId: 1, name: 'Камера уличная IP 4Мп iFLOW', book: 12 },
		{ productId: 2, name: 'Уличная камера купольная 2Мп Hikvision', book: 5 },
		{ productId: 3, name: 'Купольная уличная камера 4Мп IK10 антивандальная', book: 8 },
		{ productId: 4, name: 'Камера внутренняя 2Мп', book: 14 },
		{ productId: 5, name: 'Гофротруба ПВХ 16 мм', book: 200 },
		{ productId: 6, name: 'Коммутатор 5-портовый TL-SG105', book: 7 },
		{ productId: 7, name: 'Монтажная коробка JB2-100W', book: 23 },
		{ productId: 8, name: 'Кабель ВВГнг(А)-LS 3*1,5', book: 60 },
		{ productId: 9, name: 'Видеорегистратор IP 32 канала DS-7632', book: 2 },
	],
	10: [
		{ productId: 11, name: 'Камера уличная IP 4Мп iFLOW', book: 6 },
		{ productId: 12, name: 'Жёсткий диск HDD 1Tb', book: 4 },
		{ productId: 13, name: 'Розетка на DIN рейку РАр 10-3-ОП', book: 18 },
	],
	22: [
		{ productId: 21, name: 'Дюбель-хомут 5-10 ДХ-5-10', book: 540 },
		{ productId: 22, name: 'Шкаф монтажный 19" 6U ШРН-6.300', book: 3 },
	],
};

type Phase =
	| { k: 'init' }
	| { k: 'denied' }
	| { k: 'error'; msg: string }
	| { k: 'points'; points: Point[] };

export function InventoryReport(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [storeId, setStoreId] = useState<number | null>(null);
	const [items, setItems] = useState<InvLine[] | null>(null);
	const [loadingItems, setLoadingItems] = useState(false);
	const [search, setSearch] = useState('');
	const [counts, setCounts] = useState<Record<number, string>>({});
	const [status, setStatus] = useState<'draft' | 'sent' | null>(null);

	// инициализация: мок (dev) либо реальный BX24 + канареечный гейт
	useEffect(() => {
		if (ctx.__mock) {
			setPhase({ k: 'points', points: MOCK_POINTS });
			return;
		}
		const bx = window.BX24;
		if (!bx) {
			setPhase({ k: 'error', msg: 'BX24 SDK не загружен.' });
			return;
		}
		bx.init(() => {
			fetchCurrentUserId()
				.then((uid) => {
					if (!BETA_USER_IDS.includes(uid)) {
						setPhase({ k: 'denied' });
						return;
					}
					return fetchStores().then((stores) => {
						const pts = stores.filter((s) => s.active).map((s) => ({ storeId: s.id, title: s.title }));
						setPhase({ k: 'points', points: pts });
					});
				})
				.catch((e: unknown) => setPhase({ k: 'error', msg: String(e instanceof Error ? e.message : e) }));
		});
	}, [ctx]);

	// загрузка остатков при выборе точки
	useEffect(() => {
		if (storeId == null) {
			setItems(null);
			return;
		}
		setStatus(null);
		if (ctx.__mock) {
			setItems(MOCK_STOCK[storeId] ?? []);
			return;
		}
		setLoadingItems(true);
		fetchStoreInventory(storeId)
			.then((rows) => setItems(rows))
			.catch(() => setItems([]))
			.finally(() => setLoadingItems(false));
	}, [storeId, ctx]);

	const list = items ?? [];
	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return list;
		const words = q.split(/\s+/);
		return list.filter((i) => {
			const name = i.name.toLowerCase();
			return words.every((w) => name.includes(w));
		});
	}, [list, search]);

	const isCounted = (i: InvLine): boolean => {
		const v = counts[i.productId];
		return v !== undefined && v !== '';
	};
	const counted = list.filter(isCounted).length;
	const discrepancies = list.filter((i) => isCounted(i) && Number(counts[i.productId]) !== i.book).length;

	// ── Состояния до отчёта ───────────────────────────────────────────────────
	if (phase.k === 'init') {
		return <Shell><p>Инициализация…</p></Shell>;
	}
	if (phase.k === 'denied') {
		return (
			<Shell>
				<p className="stub-calm">Раздел инвентаризации в разработке. Пока доступен не всем — продолжайте, пожалуйста, как обычно.</p>
			</Shell>
		);
	}
	if (phase.k === 'error') {
		return <Shell><p className="error">⛔ {phase.msg}</p></Shell>;
	}

	// ── Экран 1: выбор точки ──────────────────────────────────────────────────
	if (storeId == null) {
		return (
			<div className="inv">
				<header>
					<h1>Инвентаризация</h1>
					<p className="subtitle">Задача #{ctx.taskId ?? '—'} · выберите точку, где вы сейчас работаете</p>
				</header>
				{ctx.__mock && <div className="dev-banner">dev-режим: точки и остатки — мок.</div>}
				{!ctx.__mock && <div className="beta-banner">⚙️ Бета-доступ: пока этот отчёт видишь только ты.</div>}
				<div className="point-grid">
					{phase.points.map((p) => (
						<button key={p.storeId} className="point-btn" onClick={() => setStoreId(p.storeId)}>{p.title}</button>
					))}
				</div>
			</div>
		);
	}

	// ── Экран 2: подсчёт по точке ─────────────────────────────────────────────
	const point = phase.points.find((p) => p.storeId === storeId);
	return (
		<div className="inv">
			<header>
				<h1>Инвентаризация — {point?.title ?? `склад #${storeId}`}</h1>
				<p className="subtitle">
					Задача #{ctx.taskId ?? '—'} · посчитано {counted}/{list.length} · расхождений {discrepancies} ·{' '}
					<button className="linklike" onClick={() => { setStoreId(null); setStatus(null); }}>сменить точку</button>
				</p>
			</header>

			<div className="inv-toolbar">
				<input
					className="search"
					placeholder="🔎 поиск по товару (камера, кабель, шкаф…)"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					autoFocus
				/>
				<input className="barcode" placeholder="📷 штрих-код — скоро" disabled title="Сканер штрих-кода — следующий этап, задел оставлен" />
			</div>

			{loadingItems ? (
				<p>Загрузка остатков склада…</p>
			) : (
				<div className="inv-table-wrap">
					<table className="inv-table">
						<thead>
							<tr>
								<th>Товар</th>
								<th className="num">Учёт</th>
								<th className="num">Факт</th>
								<th className="num">Расхождение</th>
							</tr>
						</thead>
						<tbody>
							{filtered.map((i) => {
								const raw = counts[i.productId];
								const has = raw !== undefined && raw !== '';
								const diff = has ? Number(raw) - i.book : null;
								const cls = diff == null ? '' : diff === 0 ? 'ok' : diff < 0 ? 'short' : 'over';
								return (
									<tr key={i.productId}>
										<td>{i.name}</td>
										<td className="num">{i.book}</td>
										<td className="num">
											<input
												type="number"
												min="0"
												className="count-input"
												value={raw ?? ''}
												onChange={(e) => setCounts((c) => ({ ...c, [i.productId]: e.target.value }))}
											/>
										</td>
										<td className={`num diff ${cls}`}>{diff == null ? '—' : diff > 0 ? `+${diff}` : diff}</td>
									</tr>
								);
							})}
							{!filtered.length && (
								<tr><td colSpan={4} className="empty">{list.length ? `Ничего не найдено по «${search}»` : 'На складе нет позиций'}</td></tr>
							)}
						</tbody>
					</table>
				</div>
			)}

			<div className="inv-actions">
				<button className="btn-secondary" onClick={() => setStatus('draft')}>Сохранить</button>
				<button className="btn-primary" onClick={() => setStatus('sent')}>Отправить отчёт</button>
				{status === 'draft' && <span className="hint ok">✅ Черновик сохранён. (в проде → на Диск, можно вернуться позже)</span>}
				{status === 'sent' && <span className="hint ok">✅ Отчёт отправлен. (в проде → структурно в задачу + отметка пункта чек-листа точки)</span>}
			</div>

			<footer>
				<small>Дальше по расхождениям: списание (минус) / оприходование (плюс) — задел оставлен, пока не активно.</small>
			</footer>
		</div>
	);
}

function Shell({ children }: { children: JSX.Element }): JSX.Element {
	return (
		<div className="inv">
			<header><h1>Инвентаризация</h1></header>
			<section>{children}</section>
		</div>
	);
}
