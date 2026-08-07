import { plural, rub } from './deal-display-formatters.js';

interface RealizationItem {
	name: string;
	quantity: number;
}

interface RealizationStoreGroup {
	id: number;
	storeName: string;
	items: RealizationItem[];
}

export function DealRealizationBar({
	hasPendingDrafts,
	pendingDraftCount,
	segmentActionsBlocked,
	readyRowCount,
	realizationDocumentCount,
	storeGroups,
	workItems,
	total,
	dev,
	busy,
	supplyBusy,
	supplyGoodsCount,
	notice,
	onRealize,
	onOrderSupply,
}: {
	hasPendingDrafts: boolean;
	pendingDraftCount: number;
	segmentActionsBlocked: boolean;
	readyRowCount: number;
	realizationDocumentCount: number;
	storeGroups: RealizationStoreGroup[];
	workItems: RealizationItem[];
	total: number;
	dev: boolean;
	busy: boolean;
	supplyBusy: boolean;
	supplyGoodsCount: number;
	notice: { kind: 'ok' | 'err'; text: string } | null;
	onRealize: () => void;
	onOrderSupply: () => void;
}): JSX.Element {
	return (
		<div className="realize-bar deal-sticky-actions">
			{hasPendingDrafts ? (
				<div className="realize-plan">
					<b>Черновики в ядре: {pendingDraftCount} — проверь партии ниже и проведи.</b>
					<span className="hint">«Провести» спишет остаток ядра. Если закрыть сделку, кнопка восстановится при следующем открытии.</span>
				</div>
			) : segmentActionsBlocked ? (
				<span className="hint">Для реализации выбери «Вид по этапам» — так цена и отгрузка попадут именно в нужный этап.</span>
			) : readyRowCount > 0 ? (
				<div className="realize-plan">
					<b>К реализации — {realizationDocumentCount} {plural(realizationDocumentCount, 'документ', 'документа', 'документов')}:</b>
					{storeGroups.map((group) => (
						<span key={group.id} className="plan-group">{group.storeName}: {group.items.map((item) => `${item.name.slice(0, 22)} ×${item.quantity}`).join(' · ')}</span>
					))}
					{workItems.length > 0 && <span className="plan-group">Услуги · в едином документе, без склада: {workItems.map((item) => `${item.name.slice(0, 22)} ×${item.quantity}`).join(' · ')}</span>}
				</div>
			) : (
				<span className="hint">Отметь строки галочками: доступное можно реализовать, отсутствующее — заказать через снабжение.</span>
			)}
			<div className="realize-actions">
				<div className="deal-action-total"><span>Общая сумма</span><b>{rub(total)}</b></div>
				<button
					className={`btn-realize-all${hasPendingDrafts ? ' submit' : ''}`}
					disabled={dev || busy || supplyBusy || (hasPendingDrafts ? pendingDraftCount === 0 : realizationDocumentCount === 0)}
					title={dev ? 'В dev-режиме недоступно — реализация считается на проде через ядро' : undefined}
					onClick={onRealize}
				>
					{busy ? '…' : hasPendingDrafts ? '✓ Провести' : `Реализация${realizationDocumentCount ? ` (${realizationDocumentCount})` : ''}`}
				</button>
				{!hasPendingDrafts && supplyGoodsCount > 0 && (
					<button className="btn-cancel-draft" disabled={dev || busy || supplyBusy} title="Сформировать заказ по отмеченным товарам для дисплея снабжения" onClick={onOrderSupply}>{supplyBusy ? '…' : `Заказать (${supplyGoodsCount})`}</button>
				)}
			</div>
			{notice && <span className={notice.kind === 'ok' ? 'realize-ok' : 'error'}>{notice.text}</span>}
		</div>
	);
}
