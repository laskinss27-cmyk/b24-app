import { type SupplyViewKey } from './SupplyNavigation.js';
import { type StandaloneDocumentKind } from './SupplyStandaloneDocumentModal.js';

export function SupplyPageHeader({ view, onCreate }: { view: SupplyViewKey; onCreate: (kind: StandaloneDocumentKind) => void }): JSX.Element {
	return (
		<header className="supply-proto-top">
			<div>
				<h1>Снабжение</h1>
				<p>{view === 'marketplaces'
					? 'Продажи, комплекты и возвраты товаров на маркетплейсах.'
					: view === 'stocks'
					? 'Каталог товаров и актуальные остатки по складам.'
					: view === 'ledger'
					? 'История прихода, перемещения, реализации и инвентаризации по выбранному товару.'
					: view === 'turnover'
					? 'Оборачиваемость каждой товарной позиции за выбранный период и текущая ситуация с запасами.'
					: view === 'matrix'
					? 'Категорийная матрица остатков, продаж и рекомендуемого заказа на запас 60 дней.'
					: view === 'inventory'
					? 'Создание и проведение инвентаризаций по торговым точкам и складам.'
					: view === 'incoming'
						? 'Заявки торговых точек, по которым снабжение должно принять решение.'
					: view === 'logistics'
						? 'Все перемещения: самостоятельные и созданные по заявкам или закупкам.'
						: view === 'issue'
							? 'Списания со склада, с привязкой к сделке там, где она есть.'
							: view === 'receipt'
								? 'Все оприходования: поставщик, склад, состав документа и связанная сделка.'
								: view === 'delivery'
									? 'Реализации товаров по сделкам и самостоятельные документы.'
									: view === 'return'
										? 'Возвраты клиентов с исходной сделкой и составом документа.'
										: 'Заявка раскрывается в строки, снабжение вручную выбирает закупку или перемещение.'}</p>
			</div>
			<div className="supply-proto-actions">
				{view === 'purchase' && <button className="primary" type="button" onClick={() => onCreate('purchase')}>Создать заявку поставщику</button>}
				{view === 'logistics' && <button className="primary" type="button" onClick={() => onCreate('transfer')}>Создать перемещение</button>}
				{view === 'issue' && <button className="primary" type="button" onClick={() => onCreate('issue')}>Создать списание</button>}
				{view === 'receipt' && <button className="primary" type="button" onClick={() => onCreate('receipt')}>Создать оприходование</button>}
			</div>
		</header>
	);
}
