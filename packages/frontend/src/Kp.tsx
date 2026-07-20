import { useEffect, useState } from 'react';
import { fetchDealKp, withTimeout, type KpData, type KpRow } from './b24.js';
import { REPAIR_LOGO } from './repair-logo.js';

/**
 * КП (коммерческое предложение) из сделки — печатный документ под бренд (красный #ED2024 + белый).
 * Данные из /api/deal/kp (клиент/менеджер/товары/работы/итоги). Фото товаров пока заглушка-рамка
 * (подключим из ядра Item.image). Печать через window.print + @media print.
 */

const COMPANY = { name: 'ИП Поляков Д. Ю.', phone: '+7 812 963-02-32', site: 'dom-automation.ru' };
const money = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
function ruDate(s: string): string {
	if (!s) return '';
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
	return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

const MOCK_KP: KpData = {
	number: 1042, date: new Date().toISOString(), title: 'Видеонаблюдение, коттедж',
	client: { name: 'Иванов Пётр Сергеевич', phone: '+7 921 100-20-30' },
	manager: { name: 'Сергей Ласкин', phone: '+7 921 091-70-19' },
	goods: [
		{ productId: 101, name: 'IP-камера AHD 2 Мп', article: 'Eltis B-21', qty: 4, price: 2400, sum: 9600, isWork: false },
		{ productId: 102, name: 'Видеорегистратор 8-канальный', article: 'Lock-E01', qty: 1, price: 8900, sum: 8900, isWork: false },
		{ productId: 103, name: 'Монитор видеодомофона 7"', article: 'CTV-M5702', qty: 2, price: 3500, sum: 7000, isWork: false },
	],
	works: [
		{ productId: 0, name: 'Монтаж и настройка камер', article: '', qty: 4, price: 2500, sum: 10000, isWork: true },
		{ productId: 0, name: 'Пусконаладка системы', article: '', qty: 1, price: 8000, sum: 8000, isWork: true },
	],
	sumGoods: 25500, sumWorks: 18000, total: 43500,
};

export function KpDocument({ dealId, variantId, mock, onBack }: { dealId: number | null; variantId?: string; mock: boolean; onBack: () => void }): JSX.Element {
	const [kp, setKp] = useState<KpData | null>(null);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		if (mock) { setKp(MOCK_KP); return; }
		if (dealId == null) { setErr('Не пришёл ID сделки.'); return; }
		withTimeout(fetchDealKp(dealId, variantId), 30000, 'deal/kp').then(setKp).catch((e: unknown) => setErr(String(e instanceof Error ? e.message : e)));
	}, [dealId, mock, variantId]);

	// Единая сетка колонок для таблиц товаров и работ — чтобы цифры (кол-во/цена/сумма) стояли в один столбец.
	const renderCols = (): JSX.Element => (
		<colgroup>
			<col style={{ width: '42px' }} />
			<col />
			<col style={{ width: '58px' }} />
			<col style={{ width: '96px' }} />
			<col style={{ width: '104px' }} />
		</colgroup>
	);
	const goodsRow = (r: KpRow, i: number): JSX.Element => (
		<tr key={`g${i}`} className={i % 2 ? 'kp-zebra' : ''}>
			<td className="kp-photo-cell">{r.photo ? <img src={r.photo} alt="" className="kp-photo" /> : <div className="kp-photo kp-photo-empty" />}</td>
			<td>{r.name}{r.article && <div className="kp-article">{r.article}</div>}</td>
			<td className="kp-num">{r.qty}</td>
			<td className="kp-num">{money(r.price)}</td>
			<td className="kp-num">{money(r.sum)}</td>
		</tr>
	);
	const workRow = (r: KpRow, i: number): JSX.Element => (
		<tr key={`w${i}`} className={i % 2 ? 'kp-zebra' : ''}>
			<td colSpan={2}>{r.name}</td>
			<td className="kp-num">{r.qty}</td>
			<td className="kp-num">{money(r.price)}</td>
			<td className="kp-num">{money(r.sum)}</td>
		</tr>
	);

	return (
		<div className="kp-wrap">
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				{kp && <button className="btn-primary" onClick={() => window.print()}>🖨 Печать</button>}
				<span className="muted small">фото подключим из ядра — сейчас рамка-заглушка</span>
			</div>

			{err && <p className="error">⛔ {err}</p>}
			{!kp && !err && <p className="base-load">Собираю КП…</p>}

			{kp && (
				<div className="kp-doc">
					<div className="kp-head">
						<img className="kp-logo" src={REPAIR_LOGO} alt="Умный дом" />
						<div className="kp-req">{COMPANY.name}<br />{COMPANY.phone}<br />{COMPANY.site}</div>
					</div>

					<div className="kp-title">Коммерческое предложение № {kp.number}</div>
					{kp.variantName && <div className="kp-meta"><b>{kp.variantName}</b></div>}
					<div className="kp-meta">от {ruDate(kp.date)}{kp.manager.name ? ` · менеджер: ${kp.manager.name}` : ''}{kp.manager.phone ? ` · ${kp.manager.phone}` : ''}</div>
					<div className="kp-client">Клиент: <b>{kp.client.name || '—'}</b>{kp.client.phone && <> · {kp.client.phone}</>}</div>

					{kp.goods.length > 0 && (
						<>
							<div className="kp-section">Оборудование</div>
							<table className="kp-table">
								{renderCols()}
								<thead><tr><th colSpan={2}>Наименование</th><th className="kp-num">Кол-во</th><th className="kp-num">Цена</th><th className="kp-num">Сумма</th></tr></thead>
								<tbody>{kp.goods.map(goodsRow)}</tbody>
							</table>
						</>
					)}

					{kp.works.length > 0 && (
						<>
							<div className="kp-section">Работы</div>
							<table className="kp-table">
								{renderCols()}
								<tbody>{kp.works.map(workRow)}</tbody>
							</table>
						</>
					)}

					<div className="kp-totals">
						{kp.goods.length > 0 && <div className="kp-trow"><span>Оборудование</span><span>{money(kp.sumGoods)}</span></div>}
						{kp.works.length > 0 && <div className="kp-trow"><span>Работы</span><span>{money(kp.sumWorks)}</span></div>}
						<div className="kp-trow kp-grand"><span>Итого</span><span className="kp-grand-sum">{money(kp.total)}</span></div>
					</div>

					<div className="kp-foot">Предложение действительно 14 дней. Гарантия на оборудование — по гарантии производителя, на работы — 12 мес.</div>
				</div>
			)}
		</div>
	);
}
