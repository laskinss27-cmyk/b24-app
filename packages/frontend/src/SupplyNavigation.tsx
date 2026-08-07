import { type StockMovementKind } from './StockLedger.js';

export type SupplyViewKey = 'orders' | 'incoming' | 'purchase' | 'logistics' | 'stocks' | 'marketplaces' | StockMovementKind | 'ledger' | 'turnover' | 'matrix' | 'inventory';

export const ASSORTMENT_MATRIX_CANARY_IDS = new Set(['1858']);

export function SupplyNavigation({ view, reportsOpen, marketplaceOnly, canOpenMarketplaces, currentUserId, mock, onViewChange, onToggleReports }: {
	view: SupplyViewKey;
	reportsOpen: boolean;
	marketplaceOnly: boolean;
	canOpenMarketplaces: boolean;
	currentUserId: string;
	mock: boolean;
	onViewChange: (view: SupplyViewKey) => void;
	onToggleReports: () => void;
}): JSX.Element {
	return (
	<aside className="supply-proto-rail">
		<div className="supply-proto-brand"><span>С</span><div><b>Снаб</b><small>рабочий сценарий</small></div></div>
		<nav className="supply-proto-nav" aria-label="Разделы снабжения">
			{!marketplaceOnly && <>
				<div className="supply-proto-nav-group">
					<button className={view === 'orders' ? 'active' : ''} type="button" onClick={() => onViewChange('orders')}>Обеспечение и заказы</button>
					<button className={view === 'incoming' ? 'active' : ''} type="button" onClick={() => onViewChange('incoming')}>Входящие заявки ТТ</button>
					<button className={view === 'purchase' ? 'active' : ''} type="button" onClick={() => onViewChange('purchase')}>Закупки</button>
					<button className={view === 'logistics' ? 'active' : ''} type="button" onClick={() => onViewChange('logistics')}>Логистика</button>
				</div>
				<div className="supply-proto-nav-group">
					<button className={view === 'receipt' ? 'active' : ''} type="button" onClick={() => onViewChange('receipt')}>Оприходования</button>
					<button className={view === 'delivery' ? 'active' : ''} type="button" onClick={() => onViewChange('delivery')}>Реализации</button>
					<button className={view === 'issue' ? 'active' : ''} type="button" onClick={() => onViewChange('issue')}>Списания</button>
					<button className={view === 'return' ? 'active' : ''} type="button" onClick={() => onViewChange('return')}>Возвраты</button>
					<button className={view === 'inventory' ? 'active' : ''} type="button" onClick={() => onViewChange('inventory')}>Инвентаризация</button>
				</div>
				<div className="supply-proto-nav-group">
					<button className={view === 'stocks' ? 'active' : ''} type="button" onClick={() => onViewChange('stocks')}>Остатки</button>
					<button
						className={`supply-proto-nav-parent${view === 'ledger' || view === 'turnover' || view === 'matrix' ? ' active' : ''}`}
						type="button"
						aria-expanded={reportsOpen}
						aria-controls="supply-reports-menu"
						onClick={onToggleReports}
					>
						<span>Отчёты</span><span aria-hidden="true">{reportsOpen ? '⌃' : '⌄'}</span>
					</button>
					{reportsOpen && (
						<div id="supply-reports-menu" className="supply-proto-subnav">
							<button className={view === 'ledger' ? 'active' : ''} type="button" onClick={() => onViewChange('ledger')}>Движение товаров</button>
							<button className={view === 'turnover' ? 'active' : ''} type="button" onClick={() => onViewChange('turnover')}>Оборачиваемость</button>
							{ASSORTMENT_MATRIX_CANARY_IDS.has(currentUserId) && <button className={view === 'matrix' ? 'active' : ''} type="button" onClick={() => onViewChange('matrix')}>Матрица заказа <small>β</small></button>}
						</div>
					)}
				</div>
			</>}
			{canOpenMarketplaces && <div className="supply-proto-nav-group">
				<button className={view === 'marketplaces' ? 'active' : ''} type="button" onClick={() => onViewChange('marketplaces')}>Маркетплейсы</button>
			</div>}
		</nav>
		<div className="supply-proto-source">Данные: {mock ? 'демо' : 'ядро'}<br />Документы: {mock ? 'превью' : 'живые'}</div>
	</aside>
	);
}
