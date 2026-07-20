import { useEffect, useMemo, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchCurrentUserId,
	fetchRealizations,
	openDeal,
	openRealization,
	isPortalAdmin,
	withTimeout,
	MANAGEMENT_USER_IDS,
	type RealizationRow,
} from './b24.js';

/**
 * Окно «Реализации ↔ сделки» — зеркало нативного списка «Документы реализации»
 * + колонка СДЕЛКА, которой в родном экране нет (клик → открыть сделку).
 *
 * Вход: кнопка в «Базе товаров» (onBack). 100% read-only, сборка на бэкенде
 * (/api/realizations/list). Доступ ограничен управленческими учётными записями.
 */

type Phase = { k: 'init' } | { k: 'denied' } | { k: 'ready' };

const MOCK_ROWS: RealizationRow[] = [
	{ shipmentId: 1528, orderId: 930, account: '930/2', date: '2026-06-10T01:02:00+03:00', responsible: 'Ласкин Константин', sum: 8000, client: 'Александр Росатом', clientSub: '', deal: { id: 36540, title: 'Выезд инженера на осмотр' } },
	{ shipmentId: 1504, orderId: 918, account: '918/2', date: '2026-06-09T17:43:00+03:00', responsible: 'Кошиц Станислав', sum: 31500, client: 'Михаил', clientSub: 'ИП Парфентьев Михаил Сергеевич', deal: { id: 36402, title: 'Умный дом, коттедж' } },
	{ shipmentId: 1450, orderId: 860, account: '860/3', date: '2026-06-09T15:53:00+03:00', responsible: 'Кабардин Егор', sum: 18550, client: 'Александр Медведев', clientSub: '', deal: { id: 32602, title: 'СКД на дверях 17 этаж' } },
	{ shipmentId: 1402, orderId: 884, account: '884/2', date: '2026-06-09T15:28:00+03:00', responsible: 'Кабардин Егор', sum: 27358, client: 'гор', clientSub: '', deal: null },
];

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }
/** ISO Б24 → DD.MM.YYYY HH:MM. */
function ruDateTime(s: string): string {
	if (!s) return '';
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function money(n: number): string { return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽'; }
function hhmm(iso: string): string {
	if (!iso) return '';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function Realizations({ onBack }: { onBack?: (() => void) | undefined }): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [rows, setRows] = useState<RealizationRow[] | null>(null);
	const [meta, setMeta] = useState<{ generatedAt: string; truncated: boolean } | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [q, setQ] = useState('');
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');

	async function load(force: boolean): Promise<void> {
		setErr(null);
		if (from && to && from > to) { setErr('Дата «с» позже даты «по».'); return; }
		if (ctx.__mock) {
			setRows(MOCK_ROWS);
			setMeta({ generatedAt: new Date().toISOString(), truncated: false });
			return;
		}
		(force ? setRefreshing : setLoading)(true);
		try {
			const data = await withTimeout(fetchRealizations({ from: from || undefined, to: to || undefined, force }), 90000, 'realizations/list');
			setRows(data.rows);
			setMeta({ generatedAt: data.generatedAt, truncated: data.truncated });
		} catch (e: unknown) {
			setErr(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}

	useEffect(() => {
		if (ctx.__mock) {
			setPhase({ k: 'ready' });
			void load(false);
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
				await load(false);
			})().catch((e: unknown) => {
				setErr(String(e instanceof Error ? e.message : e));
				setPhase({ k: 'ready' });
			});
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	const view = useMemo(() => {
		if (!rows) return [];
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) return rows;
		return rows.filter((r) => {
			const hay = `${r.account} ${r.client} ${r.clientSub} ${r.responsible} ${r.deal ? `${r.deal.id} ${r.deal.title}` : ''}`.toLowerCase();
			return words.every((w) => hay.includes(w));
		});
	}, [rows, q]);

	const total = useMemo(() => view.reduce((s, r) => s + r.sum, 0), [view]);

	if (phase.k === 'init') return <Shell onBack={onBack}><p className="base-load">Загрузка…</p></Shell>;
	if (phase.k === 'denied') return <Shell onBack={onBack}><p className="stub-calm">Окно реализаций доступно руководителям. Если нужен доступ — напишите.</p></Shell>;

	return (
		<Shell onBack={onBack}>
			<>
				<div className="base-toolbar">
					<label className="tb-field tb-search">Поиск (реализация · клиент · сделка · менеджер)
						<input type="search" value={q} placeholder="930, медведев, СКД, кабардин…" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
					</label>
					<label className="tb-field">Период с
						<input type="date" className="inv-date" value={from} onChange={(e) => setFrom(e.target.value)} />
					</label>
					<label className="tb-field">по
						<input type="date" className="inv-date" value={to} onChange={(e) => setTo(e.target.value)} />
					</label>
					<button className="btn-primary" onClick={() => void load(false)} disabled={loading || refreshing} title="Показать реализации за период">{loading ? 'Гружу…' : 'Показать'}</button>
					{(from || to) && <button className="btn-secondary" onClick={() => { setFrom(''); setTo(''); }} title="Сбросить период (последние реализации)">✕ период</button>}
					<div className="tb-spacer" />
					<button className="btn-secondary" onClick={() => void load(true)} disabled={refreshing || loading} title="Пересобрать список из Битрикса">{refreshing ? 'Обновляю…' : '↻ Обновить'}</button>
				</div>

				{err && <p className="error">⛔ {err}</p>}
				{loading && !rows && <p className="muted">Собираю реализации и связываю со сделками…</p>}

				{rows && (view.length === 0 ? (
					<p className="stub-calm">{q ? 'Ничего не найдено.' : 'Реализаций не найдено.'}</p>
				) : (
					<div className="table-wrap">
						<table className="products-table report-table">
							<thead>
								<tr>
									<th>Реализация</th><th>Статус</th><th>Дата</th><th>Ответственный</th>
									<th className="num">Сумма</th><th>Клиент</th><th className="col-deal-h">Сделка</th>
								</tr>
							</thead>
							<tbody>
								{view.map((r) => (
									<tr key={r.shipmentId}>
										<td><button className="link-btn" title="Открыть реализацию" onClick={() => openRealization(r.shipmentId)}><b>Реализация #{r.account}</b></button></td>
										<td><span className="status-ok">Проведён</span></td>
										<td className="muted nowrap">{ruDateTime(r.date)}</td>
										<td>{r.responsible || '—'}</td>
										<td className="num money">{money(r.sum)}</td>
										<td>{r.client || <span className="muted">—</span>}{r.clientSub && <div className="muted small">{r.clientSub}</div>}</td>
										<td className="col-deal">
											{r.deal ? (
												<button className="deal-chip" title="Открыть сделку" onClick={() => openDeal(r.deal!.id)}>
													#{r.deal.id} {r.deal.title} ↗
												</button>
											) : <span className="muted">—</span>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				))}

				<div className="base-foot">
					<span>Реализаций: {view.length}{meta?.truncated ? ` (последние ${rows?.length ?? 0})` : ''}</span>
					<span>{meta ? `данные на ${hhmm(meta.generatedAt)}` : ''}</span>
					<span>Сумма (видимое): {money(total)}</span>
				</div>
			</>
		</Shell>
	);
}

function Shell({ children, onBack }: { children: JSX.Element; onBack?: (() => void) | undefined }): JSX.Element {
	return (
		<div className="inv">
			{onBack && <div className="base-backbar"><button className="btn-secondary" onClick={onBack}>← База товаров</button></div>}
			<header>
				<h1>📄 Реализации</h1>
				<p className="subtitle">Зеркало складских реализаций + сделка и клиент · клик по сделке открывает её</p>
			</header>
			<section>{children}</section>
		</div>
	);
}
