import { useEffect, useState, type CSSProperties } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { listTransfers, shipTransfer, receiveTransfer, fetchMovements, openDeal, fetchCurrentUserId, isPortalAdmin, withTimeout, BETA_USER_IDS, type TransferDoc, type CoreMovement } from './b24.js';

/** Кликабельная ссылка на сделку + ФИО ответственного (общий вид для всех складских документов). */
function DealCell({ dealId, ownerName }: { dealId: string; ownerName?: string | undefined }): JSX.Element {
	if (!dealId) return <span style={{ color: '#7a8699' }}>—</span>;
	return (
		<div>
			<a href="#" onClick={(e) => { e.preventDefault(); openDeal(Number(dealId)); }} style={{ color: '#185fa5', textDecoration: 'none' }}>Сделка #{dealId}</a>
			{ownerName ? <div style={{ color: '#7a8699', fontSize: 12 }}>{ownerName}</div> : null}
		</div>
	);
}

/**
 * Окно «Складской учёт» (левое меню, view='stock'). Вкладки:
 *  - Перемещения — рабочая: список + кнопки «В пути»/«Получено» для снабжения (isSupply);
 *  - Списания / Оприходования / Реализации — read-only журнал документов ядра.
 */
type Tab = 'transfers' | 'issue' | 'receipt' | 'delivery';
const TABS: Array<{ key: Tab; label: string }> = [
	{ key: 'transfers', label: 'Перемещения' },
	{ key: 'issue', label: 'Списания' },
	{ key: 'receipt', label: 'Оприходования' },
	{ key: 'delivery', label: 'Реализации' },
];
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);

const tabStyle = (active: boolean): CSSProperties => ({
	padding: '9px 16px', border: 'none', borderBottom: active ? '2px solid #185fa5' : '2px solid transparent',
	background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: active ? 600 : 400, color: active ? '#185fa5' : '#1a2231',
});
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };

type Phase = { k: 'init' } | { k: 'denied' } | { k: 'ready' };

export function StockLedger(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [tab, setTab] = useState<Tab>('transfers');

	// Канарейка: окно видит только BETA_USER_IDS / админ портала (как База/Реализации).
	useEffect(() => {
		if (ctx.__mock) { setPhase({ k: 'ready' }); return; }
		const bx = window.BX24;
		if (!bx) { setPhase({ k: 'ready' }); return; }
		bx.init(() => {
			void (async () => {
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				setPhase(!isPortalAdmin() && !BETA_USER_IDS.includes(uid) ? { k: 'denied' } : { k: 'ready' });
			})().catch(() => setPhase({ k: 'denied' }));
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	if (phase.k === 'init') return <div style={{ padding: 24, color: '#7a8699' }}>Загрузка…</div>;
	if (phase.k === 'denied') return <div style={{ padding: 24, color: '#7a8699' }}>🔒 Раздел в обкатке — доступен ограниченному кругу.</div>;
	return (
		<div style={{ maxWidth: 980, margin: '0 auto', padding: 16, color: '#1a2231' }}>
			<h1 style={{ fontSize: 20, margin: '0 0 12px' }}>🏬 Складской учёт</h1>
			<div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e3e8ef', marginBottom: 14, flexWrap: 'wrap' }}>
				{TABS.map((t) => (
					<button key={t.key} style={tabStyle(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
				))}
			</div>
			{tab === 'transfers' ? <TransfersTab /> : <MovementsTab kind={tab} />}
		</div>
	);
}

function TransfersTab(): JSX.Element {
	const [list, setList] = useState<TransferDoc[] | null>(null);
	const [isSupply, setIsSupply] = useState(false);
	const [busy, setBusy] = useState<number | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const load = async (): Promise<void> => {
		try { const r = await listTransfers(); setList(r.transfers); setIsSupply(r.isSupply); }
		catch (e) { setErr(errText(e)); }
	};
	useEffect(() => { void load(); }, []);
	const act = async (t: TransferDoc, kind: 'ship' | 'receive'): Promise<void> => {
		setBusy(t.id); setErr(null);
		try { await (kind === 'ship' ? shipTransfer(t.id) : receiveTransfer(t.id)); await load(); }
		catch (e) { setErr(errText(e)); }
		finally { setBusy(null); }
	};
	if (err) return <p className="error">⛔ {err}</p>;
	if (!list) return <p>Загрузка…</p>;
	if (!list.length) return <p className="empty">Перемещений пока нет. Создаются из карточки сделки.</p>;
	const STATUS: Record<string, string> = { requested: '⏳ запрошено', in_transit: '🚚 в пути', received: '✅ получено', canceled: 'отменено' };
	return (
		<>
			{!isSupply && <p style={{ color: '#7a8699', fontSize: 13 }}>Кнопки «В пути»/«Получено» доступны снабжению. У тебя — просмотр.</p>}
			<table style={{ width: '100%', borderCollapse: 'collapse' }}>
				<thead><tr><th style={TH}>Сделка</th><th style={TH}>Маршрут</th><th style={TH}>Позиции</th><th style={TH}>Статус</th><th style={TH}></th></tr></thead>
				<tbody>
					{list.map((t) => (
						<tr key={t.id}>
							<td style={TD}><DealCell dealId={t.dealId} ownerName={t.ownerName} /><div style={{ color: '#7a8699', fontSize: 12 }}>{(t.createdAt || '').slice(0, 10)}</div></td>
							<td style={TD}>{t.fromStore} → {t.toStore}</td>
							<td style={TD}>{t.lines.map((l) => `${l.name || ('#' + l.productId)} × ${l.qty}`).join(', ')}</td>
							<td style={TD}>{STATUS[t.status] ?? t.status}</td>
							<td style={TD}>
								{isSupply && t.status === 'requested' && <button className="btn-primary" disabled={busy != null} onClick={() => void act(t, 'ship')}>{busy === t.id ? '…' : 'В пути'}</button>}
								{isSupply && t.status === 'in_transit' && <button className="btn-primary" disabled={busy != null} onClick={() => void act(t, 'receive')}>{busy === t.id ? '…' : 'Получено'}</button>}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	);
}

function MovementsTab({ kind }: { kind: 'issue' | 'receipt' | 'delivery' }): JSX.Element {
	const [list, setList] = useState<CoreMovement[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		let alive = true; setList(null); setErr(null);
		fetchMovements(kind).then((m) => { if (alive) setList(m); }).catch((e) => { if (alive) setErr(errText(e)); });
		return () => { alive = false; };
	}, [kind]);
	if (err) return <p className="error">⛔ {err}</p>;
	if (!list) return <p>Загрузка…</p>;
	if (!list.length) return <p className="empty">Документов нет.</p>;
	return (
		<table style={{ width: '100%', borderCollapse: 'collapse' }}>
			<thead><tr><th style={TH}>Документ</th><th style={TH}>Дата</th><th style={TH}>Сделка / ответственный</th><th style={TH}>Инфо</th><th style={TH}>Статус</th></tr></thead>
			<tbody>
				{list.map((m) => (
					<tr key={m.name}><td style={TD}>{m.name}</td><td style={TD}>{m.date}</td><td style={TD}><DealCell dealId={m.dealId} ownerName={m.ownerName} /></td><td style={TD}>{m.summary}</td><td style={TD}>{m.submitted ? 'проведён' : 'черновик'}</td></tr>
				))}
			</tbody>
		</table>
	);
}
