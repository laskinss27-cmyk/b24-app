import { plural, rub } from './deal-display-formatters.js';

export function DealProductsSummaryHeader({
	dealId,
	rowCount,
	viewer,
	goodsTotal,
	worksTotal,
	total,
	plannedGoodsProfit,
	unknownGoods,
	pricedGoodsCount,
	actualProfit,
	repairProfit,
}: {
	dealId: number | null;
	rowCount: number;
	viewer: string;
	goodsTotal: number;
	worksTotal: number;
	total: number;
	plannedGoodsProfit: number;
	unknownGoods: number;
	pricedGoodsCount: number;
	actualProfit?: import('@b24-app/shared').DealActualProfit | null | undefined;
	repairProfit?: import('@b24-app/shared').DealRepairProfit | null | undefined;
}): JSX.Element {
	const showGoodsProfit = !repairProfit || pricedGoodsCount > 0 || (actualProfit?.goodsRevenue ?? 0) !== 0 || (actualProfit?.goodsProfit ?? 0) !== 0 || (actualProfit?.missingCostLines ?? 0) > 0;
	return (
		<header className="deal-head">
			<div>
				<h1>Товары сделки</h1>
				<p className="subtitle">Сделка #{dealId ?? '—'} · {rowCount} {plural(rowCount, 'строка', 'строки', 'строк')} · смотрит: {viewer}</p>
			</div>
			<div className={`deal-head-stats${repairProfit && showGoodsProfit ? ' has-repair-and-goods' : ''}`}>
				<div><span>Сумма товаров</span><b>{rub(goodsTotal)}</b></div>
				<div><span>Сумма работ</span><b>{rub(worksTotal)}</b></div>
				<div><span>Общая сумма</span><b>{rub(total)}</b></div>
				{showGoodsProfit && <div className="deal-profit-card">
					<span>Прибыль товаров</span>
					<dl className="deal-profit-comparison">
						{actualProfit !== undefined && <>
							<dt title="Проведённые реализации минус возвраты. Себестоимость — из складских проводок.">Факт</dt>
							<dd><b className={`deal-profit-value${(actualProfit?.goodsProfit ?? 0) > 0 ? ' positive' : (actualProfit?.goodsProfit ?? 0) < 0 ? ' negative' : ''}`}>{actualProfit?.goodsProfit == null ? '—' : rub(actualProfit.goodsProfit)}</b></dd>
						</>}
						<dt title="Сумма товаров по составу сделки минус их закупочная стоимость. Услуги не включены.">План · оценка</dt>
						<dd><b className={`deal-profit-value${plannedGoodsProfit > 0 ? ' positive' : plannedGoodsProfit < 0 ? ' negative' : ''}`}>{unknownGoods > 0 && unknownGoods === pricedGoodsCount ? '—' : `${unknownGoods ? '≈ ' : ''}${rub(plannedGoodsProfit)}`}</b></dd>
					</dl>
					{actualProfit !== undefined && <small>{!actualProfit ? 'Себестоимость недоступна' : !actualProfit.documentCount ? 'Нет проведённых реализаций' : actualProfit.missingCostLines ? `Нет полных данных: ${actualProfit.missingCostLines} строк` : 'Реализации минус возвраты'}</small>}
					{unknownGoods > 0 && <small>План без {unknownGoods} из {pricedGoodsCount} строк: нет закупочной цены</small>}
				</div>}
				{repairProfit && <div className="deal-profit-card">
					<span>Прибыль ремонта</span>
					<b className={`deal-profit-value${(repairProfit.profit ?? 0) > 0 ? ' positive' : (repairProfit.profit ?? 0) < 0 ? ' negative' : ''}`}>{repairProfit.profit == null ? '—' : rub(repairProfit.profit)}</b>
					<dl className="deal-profit-comparison">
						<dt>Цена клиенту</dt><dd>{repairProfit.clientPrice == null ? '—' : rub(repairProfit.clientPrice)}</dd>
						<dt>Цена СЦ</dt><dd>{repairProfit.serviceCost == null ? '—' : rub(repairProfit.serviceCost)}</dd>
					</dl>
					<small>{repairProfit.status}</small>
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
