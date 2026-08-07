import { plural, rub } from './deal-display-formatters.js';

export function DealProductsSummaryHeader({
	dealId,
	rowCount,
	viewer,
	goodsTotal,
	worksTotal,
	total,
	profitability,
	unknownGoods,
	pricedGoodsCount,
}: {
	dealId: number | null;
	rowCount: number;
	viewer: string;
	goodsTotal: number;
	worksTotal: number;
	total: number;
	profitability: number;
	unknownGoods: number;
	pricedGoodsCount: number;
}): JSX.Element {
	return (
		<header className="deal-head">
			<div>
				<h1>Товары сделки</h1>
				<p className="subtitle">Сделка #{dealId ?? '—'} · {rowCount} {plural(rowCount, 'строка', 'строки', 'строк')} · смотрит: {viewer}</p>
			</div>
			<div className="deal-head-stats">
				<div><span>Сумма товаров</span><b>{rub(goodsTotal)}</b></div>
				<div><span>Сумма работ</span><b>{rub(worksTotal)}</b></div>
				<div><span>Общая сумма</span><b>{rub(total)}</b></div>
				<div title={unknownGoods ? `Прибыль товаров рассчитана без ${unknownGoods} из ${pricedGoodsCount}: не заполнена закупочная цена.` : 'Прибыль товаров плюс прибыль работ.'}>
					<span>Прибыльность</span>
					<b className={`deal-profit-value${profitability > 0 ? ' positive' : profitability < 0 ? ' negative' : ''}`}>{unknownGoods ? '≈ ' : ''}{rub(profitability)}</b>
				</div>
			</div>
		</header>
	);
}

export function DealPaymentStatus({ total, paid }: { total: number; paid: number }): JSX.Element {
	const remaining = Math.max(0, total - paid);
	const fullyPaid = paid >= total - 0.01;
	const className = fullyPaid ? 'pay-full' : paid > 0 ? 'pay-partial' : 'pay-none';
	const text = fullyPaid
		? `Оплачено 100% (${rub(total)})`
		: paid > 0
			? `Частичная оплата: оплачено ${rub(paid)} · остаток ${rub(remaining)}`
			: `Не оплачено · к оплате ${rub(total)}`;

	return <div className={`deal-pay ${className}`}>{text}</div>;
}
