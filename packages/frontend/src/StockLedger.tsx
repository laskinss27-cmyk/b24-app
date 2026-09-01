import { useEffect, useState, type CSSProperties } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { InventoryHome } from './InventoryHome.js';
import { StockItemHistoryTab } from './StockItemHistoryTab.js';
import { StockMovementsTab } from './StockMovementsTab.js';
import { TransferRequestsTab } from './StockTransferRequestsTab.js';
import { StockTransfersTab } from './StockTransfersTab.js';
import type { StockForm, StockMovementKind } from './StockWorkspaceTypes.js';
import { fetchStockFormData, withTimeout } from './b24.js';

/**
 * Окно «Складской учёт» (левое меню, view='stock'). Вкладки:
 *  - Перемещения — список и рабочие действия снабжения;
 *  - Списания / Оприходования — журнал ядра + формы создания (черновик → «Провести»);
 *  - Реализации — read-only журнал (создаются из сделки).
 *  - Инвентаризация — самостоятельный модуль подсчёта и сверки остатков.
 */
export type { StockMovementKind } from './StockWorkspaceTypes.js';
export { StockItemHistoryTab as LedgerTab };
export { StockMovementsTab };
export { TransferRequestsTab };
export { StockTransfersTab };
export { TurnoverReportTab } from './StockTurnoverReportTab.js';

type Tab = 'requests' | 'transfers' | StockMovementKind | 'ledger' | 'inventory';
const TABS: Array<{ key: Tab; label: string }> = [
	{ key: 'requests', label: 'Заявки ТТ' },
	{ key: 'transfers', label: 'Перемещения' },
	{ key: 'issue', label: 'Списания' },
	{ key: 'receipt', label: 'Оприходования' },
	{ key: 'delivery', label: 'Реализации' },
	{ key: 'return', label: 'Возвраты' },
	{ key: 'ledger', label: 'Отчёт по движению товара' },
	{ key: 'inventory', label: 'Инвентаризация' },
];
const tabStyle = (active: boolean): CSSProperties => ({
	padding: '9px 16px', border: 'none', borderBottom: active ? '2px solid #185fa5' : '2px solid transparent',
	background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: active ? 600 : 400, color: active ? '#185fa5' : '#1a2231',
});

type Phase = { k: 'init' } | { k: 'denied' } | { k: 'ready' };

export function StockLedger(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const requestId = Number(new URLSearchParams(window.location.search).get('request') ?? ctx.requestId ?? 0);
	const transferId = Number(new URLSearchParams(window.location.search).get('transfer') ?? ctx.transferId ?? 0);
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [tab, setTab] = useState<Tab>(requestId > 0 ? 'requests' : 'transfers');
	const [form, setForm] = useState<StockForm | null>(null);

	// Все сотрудники видят весь складской учёт. Опасные действия отдельно защищены правами API.
	useEffect(() => {
		if (ctx.__mock) {
			setForm({ stores: ['Максидом Дунайский 64', 'Измайловский 111', 'Офис'], suppliers: ['Тантос', 'СТ Групп', 'Сити Видео', 'ЭТМ'], canCreate: true, canCancel: true });
			setPhase({ k: 'ready' });
			return;
		}
		const bx = window.BX24;
		if (!bx) { setPhase({ k: 'ready' }); return; }
		bx.init(() => {
			void (async () => {
				const access = await withTimeout(fetchStockFormData(), 15000, 'stock.form-data');
				setForm(access);
				setPhase({ k: 'ready' });
				// Справочники форм — best-effort (ядро может быть недоступно: формы просто не покажут селекторы).
			})().catch(() => setPhase({ k: 'denied' }));
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	if (phase.k === 'init') return <div style={{ padding: 24, color: '#7a8699' }}>Загрузка…</div>;
	if (phase.k === 'denied') return <div style={{ padding: 24, color: '#7a8699' }}>Не удалось определить права доступа. Обновите страницу.</div>;
	const tabs = TABS;
	return (
		<div style={{ maxWidth: tab === 'inventory' ? 1040 : 980, margin: '0 auto', padding: 16, color: '#1a2231' }}>
			<h1 style={{ fontSize: 20, margin: '0 0 12px' }}>🏬 Складской учёт</h1>
			<div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e3e8ef', marginBottom: 14, flexWrap: 'wrap' }}>
				{tabs.map((t) => (
					<button key={t.key} style={tabStyle(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
				))}
			</div>
			{tab === 'inventory' ? <InventoryHome />
				: tab === 'requests' ? <TransferRequestsTab form={form} mode="manager" {...(requestId > 0 ? { initialRequestId: requestId } : {})} />
				: tab === 'transfers' ? <StockTransfersTab form={form} showCreate={false} {...(transferId > 0 ? { initialTransferId: transferId } : {})} />
				: tab === 'ledger' ? <StockItemHistoryTab />
				: <StockMovementsTab kind={tab} form={form} showCreate={false} />}
		</div>
	);
}
