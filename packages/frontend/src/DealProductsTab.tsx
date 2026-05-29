import { useEffect, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchProductRows,
	fetchStores,
	fetchProfitCoef,
	fetchStockAndPurchasing,
	call,
	ROW_TYPE_GOODS,
	ROW_TYPE_WORK,
	BETA_USER_IDS,
	type DealProductRow,
} from './b24.js';

interface EnrichedRow extends DealProductRow {
	stocks: Array<{ storeId: number; storeName: string; amount: number }>;
	purchasingPrice: number | null;
}
interface TableData {
	rows: EnrichedRow[];
	coef: number;
}

type State =
	| { phase: 'init' }
	| { phase: 'denied' }
	| { phase: 'loading' }
	| { phase: 'error'; message: string }
	| { phase: 'ready'; data: TableData; viewer: string; dev: boolean };

// ── Mock для локального превью (BX24 в dev недоступен) ──────────────────────────
const MOCK_DATA: TableData = {
	coef: 0.5,
	rows: [
		{ id: '1', productId: 18062, name: 'Гофротруба ПВХ 16 мм', type: 1, price: 15, quantity: 80, discountSum: 0, measure: 'шт', purchasingPrice: 8, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 200 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 23 }] },
	{ id: '2', productId: 18108, name: 'IP-видеокамера iFLOW F-IC-1321M', type: 1, price: 2200, quantity: 23, discountSum: 0, measure: 'шт', purchasingPrice: null, stocks: [] },
		{ id: '3', productId: 9144, name: 'Установка и подключение видеокамеры', type: 7, price: 3000, quantity: 23, discountSum: 0, measure: 'шт', purchasingPrice: null, stocks: [] },
		{ id: '4', productId: 9200, name: 'Прокладка кабеля на высоте до 3м', type: 7, price: 150, quantity: 800, discountSum: 0, measure: 'шт', purchasingPrice: null, stocks: [] },
	],
};

async function loadAll(dealId: number): Promise<TableData> {
	const [rows, stores, coef] = await Promise.all([fetchProductRows(dealId), fetchStores(), fetchProfitCoef()]);
	const storeMap = new Map(stores.map((s) => [s.id, s.title]));
	const goodsIds = [...new Set(rows.filter((r) => r.type === ROW_TYPE_GOODS).map((r) => r.productId).filter((id) => id > 0))];
	const enrich = await fetchStockAndPurchasing(goodsIds);
	const enriched: EnrichedRow[] = rows.map((r) => {
		const e = enrich[r.productId];
		return {
			...r,
			stocks: (e?.stocks ?? []).map((s) => ({ storeId: s.storeId, amount: s.amount, storeName: storeMap.get(s.storeId) ?? `Склад #${s.storeId}` })),
			purchasingPrice: e?.purchasingPrice ?? null,
		};
	});
	return { rows: enriched, coef };
}

const rub = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** Русская плюрализация: plural(2,'строка','строки','строк') → 'строки'. */
const plural = (n: number, one: string, few: string, many: string): string => {
	const m10 = n % 10;
	const m100 = n % 100;
	if (m10 === 1 && m100 !== 11) return one;
	if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
	return many;
};

export function DealProductsTab(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [state, setState] = useState<State>({ phase: 'init' });

	useEffect(() => {
		// dev / mock: BX24 нет — показываем таблицу на мок-данных, чтоб видеть UI
		if (ctx.__mock) {
			setState({ phase: 'ready', data: MOCK_DATA, viewer: 'dev (mock)', dev: true });
			return;
		}
		const bx24 = window.BX24;
		if (!bx24) {
			setState({ phase: 'error', message: 'BX24 SDK не загружен.' });
			return;
		}
		if (ctx.dealId == null) {
			setState({ phase: 'error', message: 'Не пришёл ID сделки из placement-контекста.' });
			return;
		}
		const dealId = ctx.dealId;
		bx24.init(() => {
			call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current')
				.then((user) => {
					const viewerId = String(user.ID ?? '');
					const viewerName = `${user.NAME ?? ''} ${user.LAST_NAME ?? ''}`.trim() || viewerId;
					if (!BETA_USER_IDS.includes(viewerId)) {
						setState({ phase: 'denied' });
						return;
					}
					setState({ phase: 'loading' });
					loadAll(dealId)
						.then((data) => setState({ phase: 'ready', data, viewer: viewerName, dev: false }))
						.catch((err: unknown) => setState({ phase: 'error', message: String(err instanceof Error ? err.message : err) }));
				})
				.catch((err: unknown) => setState({ phase: 'error', message: `user.current: ${String(err instanceof Error ? err.message : err)}` }));
		});
	}, [ctx]);

	if (state.phase === 'denied') {
		return (
			<div className="deal-products-tab">
				<header>
					<h1>Товары сделки</h1>
				</header>
				<section>
					<p className="stub-calm">
						Раздел в разработке. Пользуйтесь, пожалуйста, стандартной вкладкой <strong>«Товары»</strong> —
						здесь скоро появится обновлённый вид с остатками по складам и реализацией.
					</p>
				</section>
			</div>
		);
	}

	if (state.phase === 'init' || state.phase === 'loading') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p>{state.phase === 'init' ? 'Инициализация BX24…' : 'Загрузка товаров, остатков и закупок…'}</p></section>
			</div>
		);
	}

	if (state.phase === 'error') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p className="error">⛔ {state.message}</p></section>
			</div>
		);
	}

	return <RealTable data={state.data} viewer={state.viewer} dev={state.dev} dealId={ctx.dealId} />;
}

function RealTable({ data, viewer, dev, dealId }: { data: TableData; viewer: string; dev: boolean; dealId: number | null }): JSX.Element {
	const { rows, coef } = data;
	const line = (r: EnrichedRow): number => r.price * r.quantity;

	const goods = rows.filter((r) => r.type === ROW_TYPE_GOODS);
	const works = rows.filter((r) => r.type === ROW_TYPE_WORK);
	const sumGoods = goods.reduce((a, r) => a + line(r), 0);
	const sumWorks = works.reduce((a, r) => a + line(r), 0);
	const discount = rows.reduce((a, r) => a + r.discountSum, 0);
	const total = sumGoods + sumWorks;
	const profitWorks = sumWorks * coef;
	let profitGoods = 0;
	let unknownGoods = 0;
	for (const r of goods) {
		if (r.purchasingPrice == null) unknownGoods++;
		else profitGoods += (r.price - r.purchasingPrice) * r.quantity;
	}

	return (
		<div className="deal-products-tab">
			<header>
				<h1>Товары сделки</h1>
				<p className="subtitle">Сделка #{dealId ?? '—'} · {rows.length} {plural(rows.length, 'строка', 'строки', 'строк')} · смотрит: {viewer}</p>
			</header>

			{dev
				? <div className="dev-banner">dev-режим: данные мок (BX24 недоступен локально). В проде — реальные из Битрикса.</div>
				: <div className="beta-banner">⚙️ Бета-доступ: эту таблицу пока видишь только ты. Остальные работают в стандартной вкладке «Товары».</div>}

			<div className="table-wrap">
			<table className="products-table">
				<thead>
					<tr>
						<th>Товар / работа</th>
						<th>Тип</th>
						<th className="num">Цена</th>
						<th className="num">Кол-во</th>
						<th className="num">Сумма</th>
						<th>Отгружено</th>
						<th>Склад (остаток &gt; 0)</th>
						<th>Реализовать</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => {
						const isGoods = r.type === ROW_TYPE_GOODS;
						return (
							<tr key={r.id}>
								<td>{r.name}</td>
								<td><span className={`type-badge ${isGoods ? 'goods' : 'work'}`}>{isGoods ? 'товар' : 'работа'}</span></td>
								<td className="num">{rub(r.price)}</td>
								<td className="num">{r.quantity} {r.measure}</td>
								<td className="num">{rub(line(r))}</td>
								<td>
									<span className="shipped" title="Что считать «отгруженным» — согласовываем с Володей (кандидат: проведённые списания со склада объекта). Пока не показываем угаданные числа.">
										— / {r.quantity}
									</span>
								</td>
								<td className="row-store">
									{!isGoods ? (
										<span className="none">—</span>
									) : r.stocks.length ? (
										<select defaultValue="">
											<option value="" disabled>выбрать склад…</option>
											{r.stocks.map((s) => (
												<option key={s.storeId} value={s.storeId}>{s.storeName} — {s.amount} {r.measure}</option>
											))}
										</select>
									) : (
										<span className="none">нет на складах</span>
									)}
								</td>
								<td><input type="checkbox" disabled title="Создание документов реализации отключено в этой фазе" /></td>
							</tr>
						);
					})}
				</tbody>
			</table>
			</div>

			<div className="totals">
				<div className="trow"><span>Сумма товаров</span><span>{rub(sumGoods)}</span></div>
				<div className="trow">
					<span className="approx" title={unknownGoods ? `≈: у ${unknownGoods} из ${goods.length} товаров не заполнена закупочная цена. Источник закупки уточняем у Володи.` : 'Считается по нативной закупочной цене каталога. Источник уточняем у Володи.'}>
						Прибыль товаров ≈{unknownGoods ? ` (без ${unknownGoods})` : ''}
					</span>
					<span>{rub(profitGoods)}</span>
				</div>
				<div className="trow"><span>Сумма работ</span><span>{rub(sumWorks)}</span></div>
				<div className="trow"><span>Прибыль работ (×{coef})</span><span>{rub(profitWorks)}</span></div>
				<div className="trow muted"><span>Скидка</span><span>{rub(discount)}</span></div>
				<div className="trow grand"><span>Итого</span><span>{rub(total)}</span></div>
			</div>

			<div className="realize-bar">
				<button disabled>Реализовать выделенное</button>
				<span className="hint">запись документов — следующая фаза (тест только на сделке 32592)</span>
			</div>
		</div>
	);
}
