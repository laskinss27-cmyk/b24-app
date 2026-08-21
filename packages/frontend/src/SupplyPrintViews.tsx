import { type SupplyOrderRow } from './b24.js';
import { purchaseAmount, purchaseIsCancelled, purchaseStatus } from './supply-purchase-status.js';

interface SupplyPrintLine { productId: number; itemName: string; qty: number; rate: number }

const printMoney = (value: number): string =>
	new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const printDate = (value?: string): string => {
	const date = value ? new Date(value) : new Date();
	return Number.isNaN(date.getTime()) ? (value || '—') : date.toLocaleDateString('ru-RU');
};

export function SupplyPurchasePrint({ order, name, supplier, expectedAt, lines }: {
	order: SupplyOrderRow;
	name: string;
	supplier: string;
	expectedAt: string;
	lines: SupplyPrintLine[];
}): JSX.Element {
	const total = lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
	return (
		<section className="supply-print supply-print-purchase">
			<header className="supply-print-header">
				<div><span>Умный дом</span><h1>Заявка поставщику</h1></div>
				<div className="supply-print-number"><b>{name}</b><span>от {printDate()}</span></div>
			</header>
			<dl className="supply-print-facts">
				<div><dt>Поставщик</dt><dd>{supplier || '—'}</dd></div>
				<div><dt>Заказчик</dt><dd>Умный дом</dd></div>
				<div><dt>Ожидаемая дата</dt><dd>{expectedAt ? printDate(expectedAt) : '—'}</dd></div>
				<div><dt>Основание</dt><dd>{order.standalone ? 'Самостоятельная закупка' : order.name}</dd></div>
			</dl>
			<table className="supply-print-table">
				<thead><tr><th>№</th><th>Код</th><th>Наименование</th><th>Кол-во</th><th>Закупочная цена, ₽</th><th>Сумма, ₽</th></tr></thead>
				<tbody>{lines.map((line, index) => <tr key={`${line.productId}-${index}`}><td>{index + 1}</td><td>{line.productId}</td><td>{line.itemName}</td><td className="num">{line.qty}</td><td className="num">{line.rate > 0 ? printMoney(line.rate) : '—'}</td><td className="num">{line.rate > 0 ? printMoney(line.qty * line.rate) : '—'}</td></tr>)}</tbody>
				<tfoot><tr><td colSpan={5}>Итого</td><td className="num">{total > 0 ? `${printMoney(total)} ₽` : '—'}</td></tr></tfoot>
			</table>
			<p className="supply-print-note">Просим подтвердить наличие, срок поставки и итоговую стоимость.</p>
			<div className="supply-print-signatures"><span>Поставщик ____________________</span><span>Заказчик ____________________</span></div>
		</section>
	);
}

export function SupplyApprovalPrint({ order }: { order: SupplyOrderRow }): JSX.Element {
	const purchases = (order.purchases ?? []).filter((purchase) => !purchaseIsCancelled(purchase));
	const suppliersByProduct = new Map<number, Set<string>>();
	for (const purchase of purchases) for (const line of purchase.lines) {
		const suppliers = suppliersByProduct.get(line.productId) ?? new Set<string>();
		suppliers.add(purchase.supplier || 'Поставщик не выбран');
		suppliersByProduct.set(line.productId, suppliers);
	}
	const grandTotal = purchases.reduce((sum, purchase) => sum + purchaseAmount(purchase), 0);
	return (
		<section className="supply-print supply-print-approval">
			<header className="supply-print-header">
				<div><span>Умный дом · снабжение</span><h1>Сводная заявка на согласование</h1></div>
				<div className="supply-print-number"><b>{order.name}</b><span>от {printDate(order.date)}</span></div>
			</header>
			<dl className="supply-print-facts">
				<div><dt>Сделка</dt><dd>#{order.dealId} · {order.dealTitle || '—'}</dd></div>
				<div><dt>Точка</dt><dd>{order.toStore || '—'}</dd></div>
				<div><dt>Нужно до</dt><dd>{order.deadline ? printDate(order.deadline) : '—'}</dd></div>
				<div><dt>Поставщиков</dt><dd>{purchases.length}</dd></div>
				<div><dt>Общая сумма</dt><dd>{grandTotal > 0 ? `${printMoney(grandTotal)} ₽` : '—'}</dd></div>
			</dl>
			{order.note && <p className="supply-print-note"><b>Комментарий:</b> {order.note}</p>}
			<table className="supply-print-table supply-print-approval-table">
				<thead><tr><th>Поставщик / заявка</th><th>Код</th><th>Наименование</th><th>Кол-во</th><th>Закупочная цена, ₽</th><th>Сумма, ₽</th></tr></thead>
				{purchases.map((purchase) => {
					const subtotal = purchaseAmount(purchase);
					return <tbody key={purchase.name}>
						<tr className="supplier-row"><td colSpan={6}><b>{purchase.supplier || 'Поставщик не выбран'}</b><span>{purchase.name} · {purchaseStatus(purchase).label}</span></td></tr>
						{purchase.lines.map((line, index) => {
							const alternatives = suppliersByProduct.get(line.productId)?.size ?? 0;
							const rate = Number(line.rate || 0);
							return <tr key={`${purchase.name}-${line.productId}-${index}`}><td></td><td>{line.productId}</td><td>{line.name || `#${line.productId}`}{alternatives > 1 && <small>Есть предложения от {alternatives} поставщиков</small>}</td><td className="num">{line.qty}</td><td className="num">{rate > 0 ? printMoney(rate) : '—'}</td><td className="num">{rate > 0 ? printMoney(Number(line.qty || 0) * rate) : '—'}</td></tr>;
						})}
						<tr className="subtotal-row"><td colSpan={5}>Итого по поставщику</td><td className="num">{subtotal > 0 ? printMoney(subtotal) : '—'}</td></tr>
					</tbody>;
				})}
				<tfoot><tr><td colSpan={5}>Итого к согласованию</td><td className="num">{grandTotal > 0 ? `${printMoney(grandTotal)} ₽` : '—'}</td></tr></tfoot>
			</table>
			<div className="supply-print-signatures"><span>Подготовил ____________________</span><span>Согласовал ____________________</span></div>
		</section>
	);
}
