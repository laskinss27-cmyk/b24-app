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
	actualProfit,
	coef = 0.5,
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
	actualProfit?: import('@b24-app/shared').DealActualProfit | null | undefined;
	coef?: number;
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
					<span>Плановая прибыль · оценка</span>
					<b className={`deal-profit-value${profitability > 0 ? ' positive' : profitability < 0 ? ' negative' : ''}`}>{unknownGoods ? '≈ ' : ''}{rub(profitability)}</b>
				</div>
				{actualProfit !== undefined && <div title="По проведённым реализациям за вычетом возвратов. Себестоимость — из складских проводок; новые закупочные цены её не подменяют.">
					<span>Прибыль товаров · факт</span>
					<b>{actualProfit?.goodsProfit == null ? '—' : rub(actualProfit.goodsProfit)}</b>
					<small>{!actualProfit ? 'Себестоимость недоступна' : !actualProfit.documentCount ? 'Нет проведённых реализаций' : actualProfit.missingCostLines ? `Нет полных данных: ${actualProfit.missingCostLines} строк` : 'Реализации минус возвраты'}</small>
				</div>}
				{actualProfit && actualProfit.worksRevenue !== 0 && <div title="Прибыль проведённых услуг по действующему коэффициенту; фактические затраты на услуги не учитываются.">
					<span>Прибыль услуг · оценка</span><b>≈ {rub(actualProfit.worksProfitBase * coef)}</b>
				</div>}
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
