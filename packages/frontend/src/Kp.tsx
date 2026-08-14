import { useEffect, useState } from 'react';
import { fetchDealKp, photoFullUrl, withTimeout, type KpData, type KpRow } from './b24.js';
import { REPAIR_LOGO } from './repair-logo.js';

/**
 * КП (коммерческое предложение) из сделки — печатный документ под бренд (красный #ED2024 + белый).
 * Данные из /api/deal/kp (клиент/менеджер/товары/работы/фото/итоги).
 * Печать через window.print + @media print.
 */

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

export type DealPrintKind = 'kp' | 'receipt';

function ReceiptDocument({ kp }: { kp: KpData }): JSX.Element {
	const rows = [...kp.goods, ...kp.works];
	const buyer = kp.receiptClient ?? kp.client;
	return (
		<div className="deal-receipt">
			<div className="deal-receipt-head">
				<img src={REPAIR_LOGO} alt="Умный дом" />
				<div><b>ТОВАРНЫЙ ЧЕК № {kp.number}</b><span>от {ruDate(kp.date)}</span></div>
			</div>
			<div className="deal-receipt-meta">
				<span>Продавец: <b>Умный дом</b></span>
				<span>Покупатель: <b>{buyer.name || '—'}</b>{buyer.phone ? ` · ${buyer.phone}` : ''}</span>
			</div>
			<table>
				<thead><tr><th>№</th><th>Наименование</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead>
				<tbody>{rows.map((row, index) => (
					<tr key={`${row.isWork ? 'w' : 'g'}-${row.productId}-${index}`}>
						<td>{index + 1}</td>
						<td>{row.name}{row.article && <small>{row.article}</small>}</td>
						<td className="num">{row.qty}</td>
						<td className="num">{money(row.price)}</td>
						<td className="num">{money(row.sum)}</td>
					</tr>
				))}</tbody>
			</table>
			<div className="deal-receipt-total">Итого: <b>{money(kp.total)}</b></div>
			<div className="deal-receipt-words">Всего наименований: {rows.length}, на сумму {money(kp.total)}</div>
			<div className="deal-receipt-signatures">
				<span>Продавец __________________ / {kp.manager.name || '____________'} /</span>
				<span>Покупатель ________________ / ________________ /</span>
			</div>
		</div>
	);
}

export function KpDocument({ dealId, variantId, mock, kind, onBack }: { dealId: number | null; variantId?: string; mock: boolean; kind: DealPrintKind; onBack: () => void }): JSX.Element {
	const [kp, setKp] = useState<KpData | null>(null);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		if (mock) { setKp(MOCK_KP); return; }
		if (dealId == null) { setErr('Не пришёл ID сделки.'); return; }
		withTimeout(fetchDealKp(dealId, variantId), 30000, 'deal/kp').then(setKp).catch((e: unknown) => setErr(String(e instanceof Error ? e.message : e)));
	}, [dealId, mock, variantId]);

	const printKp = async (): Promise<void> => {
		const pending = [...document.querySelectorAll<HTMLImageElement>('.kp-doc img, .deal-receipt img')]
			.filter((image) => !image.complete)
			.map((image) => new Promise<void>((resolve) => {
				image.addEventListener('load', () => resolve(), { once: true });
				image.addEventListener('error', () => resolve(), { once: true });
			}));
		if (pending.length) {
			await Promise.race([
				Promise.all(pending),
				new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
			]);
		}
		window.print();
	};

	// Единая сетка колонок для таблиц товаров и работ — чтобы цифры (кол-во/цена/сумма) стояли в один столбец.
	const renderCols = (): JSX.Element => (
		<colgroup>
			<col style={{ width: '34px' }} />
			<col style={{ width: '50px' }} />
			<col />
			<col style={{ width: '58px' }} />
			<col style={{ width: '96px' }} />
			<col style={{ width: '104px' }} />
		</colgroup>
	);
	const goodsRow = (r: KpRow, i: number): JSX.Element => {
		const photo = r.photoPath ? photoFullUrl(r.photoPath) : null;
		return (
			<tr key={`g${i}`} className={i % 2 ? 'kp-zebra' : ''}>
				<td className="kp-index">{i + 1}</td>
				<td className="kp-photo-cell">{photo ? <img src={photo} alt="" className="kp-photo" /> : <div className="kp-photo kp-photo-empty" />}</td>
				<td>{r.name}{r.article && <div className="kp-article">{r.article}</div>}</td>
				<td className="kp-num">{r.qty}</td>
				<td className="kp-num">{money(r.price)}</td>
				<td className="kp-num">{money(r.sum)}</td>
			</tr>
		);
	};
	const workRow = (r: KpRow, i: number): JSX.Element => (
		<tr key={`w${i}`} className={i % 2 ? 'kp-zebra' : ''}>
			<td className="kp-index">{(kp?.goods.length ?? 0) + i + 1}</td>
			<td className="kp-photo-cell" />
			<td>{r.name}</td>
			<td className="kp-num">{r.qty}</td>
			<td className="kp-num">{money(r.price)}</td>
			<td className="kp-num">{money(r.sum)}</td>
		</tr>
	);
	return (
		<div className="kp-wrap">
			<style media="print">{'@page { size: A4 portrait; margin: 10mm; }'}</style>
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				{kp && <button className="btn-primary" onClick={() => void printKp()}>🖨 Печать / сохранить PDF</button>}
			</div>

			{err && <p className="error">⛔ {err}</p>}
			{!kp && !err && <p className="base-load">Собираю КП…</p>}

			{kp && kind === 'kp' && (
				<div className="kp-doc">
					<div className="kp-head">
						<img className="kp-logo" src={REPAIR_LOGO} alt="Умный дом" />
						<span>СИСТЕМЫ БЕЗОПАСНОСТИ И АВТОМАТИЗАЦИИ</span>
					</div>

					<div className="kp-title">Коммерческое предложение № {kp.number}</div>
					<div className="kp-meta">от {ruDate(kp.date)}{kp.manager.name ? ` · менеджер: ${kp.manager.name}` : ''}{kp.manager.phone ? ` · ${kp.manager.phone}` : ''}</div>
					<div className="kp-client"><span>Клиент</span><b>{kp.client.name || '—'}{kp.client.phone && <> · {kp.client.phone}</>}</b></div>

					{kp.goods.length > 0 && (
						<>
							<div className="kp-section">Оборудование</div>
							<table className="kp-table">
								{renderCols()}
								<thead><tr><th>№</th><th>Фото</th><th>Наименование</th><th className="kp-num">Кол-во</th><th className="kp-num">Цена</th><th className="kp-num">Сумма</th></tr></thead>
								<tbody>{kp.goods.map(goodsRow)}</tbody>
							</table>
						</>
					)}
					{kp.works.length > 0 && (
						<>
							<div className="kp-section">Работы</div>
							<table className="kp-table">
								{renderCols()}
								<thead><tr><th>№</th><th>Фото</th><th>Наименование</th><th className="kp-num">Кол-во</th><th className="kp-num">Цена</th><th className="kp-num">Сумма</th></tr></thead>
								<tbody>{kp.works.map(workRow)}</tbody>
							</table>
						</>
					)}

					<div className="kp-totals">
						{kp.goods.length > 0 && <div className="kp-trow"><span>Оборудование</span><span>{money(kp.sumGoods)}</span></div>}
						{kp.works.length > 0 && <div className="kp-trow"><span>Работы</span><span>{money(kp.sumWorks)}</span></div>}
						<div className="kp-trow kp-grand"><span>Итого</span><span className="kp-grand-sum">{money(kp.total)}</span></div>
					</div>

					<div className="kp-terms"><b>УСЛОВИЯ ПРЕДЛОЖЕНИЯ</b><span>Предложение действительно 14 дней. Гарантия на оборудование — по гарантии производителя, на выполненные работы — 12 месяцев.</span></div>
					<div className="kp-foot"><b>Умный дом</b><span>Коммерческое предложение</span></div>
				</div>
			)}
			{kp && kind === 'receipt' && <ReceiptDocument kp={kp} />}
		</div>
	);
}
