import type { CoreDocDetail, TransferDoc } from './b24.js';

// ── Печатные формы (перемещение/списание/приход) — @media print, как КП/ремонты ──

const COMPANY = 'Умный дом';
/** Дата по-русски: «22 июня 2026 г.». */
const ruDateLong = (s: string): string => { try { return new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return s; } };

interface PrintRow { code: string; name: string; qty: number; price?: number }
export interface PrintDoc { title: string; number: string; dateRu: string; meta: Array<[string, string]>; withMoney: boolean; rows: PrintRow[]; signLeft: string; signRight: string }

/** Печатная форма складского документа (за кадром на экране, печатается через @media print). */
export function StockBlank({ doc }: { doc: PrintDoc }): JSX.Element {
	const totalQty = doc.rows.reduce((a, r) => a + r.qty, 0);
	const totalSum = doc.withMoney ? doc.rows.reduce((a, r) => a + r.qty * (r.price ?? 0), 0) : 0;
	const money = (n: number): string => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return (
		<div className="stock-blank">
			<div className="sb-title">{doc.title} {doc.number} от {doc.dateRu}</div>
			<div className="sb-meta">
				Организация: <b>{COMPANY}</b><br />
				{doc.meta.map(([k, v], i) => <span key={i}>{k}: <b>{v || '—'}</b>{i < doc.meta.length - 1 ? <br /> : null}</span>)}
			</div>
			<table className="sb-table">
				<thead>
					<tr>
						<th style={{ width: 34 }}>№</th>
						<th style={{ width: 64 }}>Код</th>
						<th>Товар</th>
						<th className="sb-num" style={{ width: 80 }}>Кол-во</th>
						{doc.withMoney ? <th className="sb-num" style={{ width: 90 }}>Цена</th> : null}
						{doc.withMoney ? <th className="sb-num" style={{ width: 100 }}>Сумма</th> : null}
					</tr>
				</thead>
				<tbody>
					{doc.rows.map((r, i) => (
						<tr key={i}>
							<td>{i + 1}</td>
							<td>{r.code}</td>
							<td>{r.name}</td>
							<td className="sb-num">{r.qty} шт</td>
							{doc.withMoney ? <td className="sb-num">{money(r.price ?? 0)}</td> : null}
							{doc.withMoney ? <td className="sb-num">{money(r.qty * (r.price ?? 0))}</td> : null}
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr className="sb-foot">
						<td colSpan={3} className="sb-num">Итого:</td>
						<td className="sb-num">{totalQty} шт</td>
						{doc.withMoney ? <td></td> : null}
						{doc.withMoney ? <td className="sb-num">{money(totalSum)}</td> : null}
					</tr>
				</tfoot>
			</table>
			<div className="sb-info">Всего наименований: {doc.rows.length}{doc.withMoney ? `, на сумму ${money(totalSum)} ₽` : ''}</div>
			<div className="sb-signs">
				<div>{doc.signLeft}: <span className="sb-signline"></span></div>
				<div>{doc.signRight}: <span className="sb-signline"></span></div>
			</div>
		</div>
	);
}

export const transferToPrint = (t: TransferDoc): PrintDoc => ({
	title: 'Накладная на перемещение', number: `№ ${t.id}`, dateRu: ruDateLong(t.createdAt),
	meta: [
		['Отправитель', t.fromStore], ['Получатель', t.toStore],
		['Основание', t.dealId ? `Сделка #${t.dealId}` : (t.note && t.note.trim() ? t.note : 'внутреннее перемещение')],
		['Ответственный', t.ownerName || t.createdByName || '—'],
	],
	withMoney: false,
	rows: t.lines.map((l) => ({ code: String(l.productId), name: l.name || `#${l.productId}`, qty: l.qty })),
	signLeft: 'Отпустил', signRight: 'Получил',
});

export const docToPrint = (d: CoreDocDetail, kind: 'issue' | 'receipt'): PrintDoc => {
	const store = d.items.find((it) => it.store)?.store || '—';
	const base = d.dealId ? `Сделка #${d.dealId}` : (d.note && d.note.trim() ? d.note : '—');
	const rows = d.items.map((it) => ({ code: String(it.productId), name: it.itemName || `#${it.productId}`, qty: it.qty, price: it.rate }));
	if (kind === 'receipt') return {
		title: 'Приходная накладная', number: d.name, dateRu: ruDateLong(d.date),
		meta: [['Поставщик', d.supplier], ['Склад', store], ['Основание', base], ['Ответственный', d.ownerName || '—']],
		withMoney: true, rows, signLeft: 'Сдал', signRight: 'Принял',
	};
	return {
		title: 'Акт о списании', number: d.name, dateRu: ruDateLong(d.date),
		meta: [['Склад', store], ['Причина', d.reason || '—'], ['Основание', base], ['Ответственный', d.ownerName || '—']],
		withMoney: false, rows, signLeft: 'Комиссия', signRight: 'Утвердил',
	};
};
