import React, { useMemo, useState, type CSSProperties } from 'react';
import { amendStockDocument, searchStockItems, type CoreDocDetail, type StockItem } from './b24.js';
import type { StockForm } from './StockWorkspaceTypes.js';

const inp: CSSProperties = { padding: '7px 9px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: 'var(--app-text)', boxSizing: 'border-box' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: 'var(--app-surface)' };
const label: CSSProperties = { display: 'block', margin: '10px 0 4px', color: 'var(--app-muted)', fontSize: 12 };
const cell: CSSProperties = { padding: 6, borderBottom: '1px solid #eef1f5', verticalAlign: 'top' };

type EditLine = CoreDocDetail['items'][number];

export function StockDocumentEditForm({ detail, form, onCancel, onSaved }: {
	detail: CoreDocDetail;
	form: StockForm;
	onCancel: () => void;
	onSaved: (name: string) => void;
}): JSX.Element {
	const [date, setDate] = useState(detail.date);
	const [supplier, setSupplier] = useState(detail.supplier);
	const [reason, setReason] = useState(detail.reason);
	const [note, setNote] = useState(detail.note);
	const [lines, setLines] = useState<EditLine[]>(detail.items);
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<StockItem[]>([]);
	const [searching, setSearching] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const stores = useMemo(() => [...new Set([...form.stores, ...lines.map((line) => line.store).filter(Boolean)])], [form.stores, lines]);
	const canAdd = detail.allowAddLines;

	const updateLine = (index: number, patch: Partial<EditLine>): void => setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));
	const removeLine = (index: number): void => setLines((current) => current.filter((_, i) => i !== index));
	const findItems = async (): Promise<void> => {
		if (!query.trim()) return;
		setSearching(true); setError('');
		try { setResults(await searchStockItems(query)); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSearching(false); }
	};
	const addItem = (item: StockItem): void => {
		const existing = lines.findIndex((line) => line.productId === item.productId && !line.sourceRow);
		if (existing >= 0) updateLine(existing, { qty: lines[existing]!.qty + 1 });
		else setLines((current) => [...current, {
			rowId: '', sourceRow: '', productId: item.productId, itemName: item.name || `#${item.productId}`,
			qty: 1, store: current[0]?.store ?? form.stores[0] ?? '', rate: 0,
		}]);
		setResults([]); setQuery('');
	};
	const save = async (): Promise<void> => {
		setError('');
		if (!lines.length) { setError('В документе должна остаться хотя бы одна позиция.'); return; }
		if (lines.some((line) => line.qty <= 0 || !line.store)) { setError('Проверьте количество и склад во всех строках.'); return; }
		setBusy(true);
		try {
			const result = await amendStockDocument({
				doctype: detail.doctype, name: detail.name, date,
				...(supplier.trim() ? { supplier: supplier.trim() } : {}),
				reason: reason.trim(), note: note.trim(),
				lines: lines.map((line) => ({
					rowId: line.rowId, sourceRow: line.sourceRow, productId: line.productId,
					qty: line.qty, store: line.store, ...(detail.kind === 'receipt' ? { rate: line.rate } : {}),
				})),
			});
			onSaved(result.name);
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(false); }
	};

	return <div>
		<div style={{ padding: '10px 12px', borderRadius: 8, background: '#fff7e6', color: '#7a4b00', fontSize: 13 }}>
			Исходный проведённый документ будет отменён. Ядро создаст и проведёт исправленную версию, а обе версии останутся в журнале.
		</div>
		<label style={label}>Дата</label>
		<input type="date" style={inp} value={date} onChange={(event) => setDate(event.target.value)} />
		{detail.kind === 'receipt' && detail.doctype === 'Purchase Receipt' && <>
			<label style={label}>Поставщик</label>
			<input list="stock-edit-suppliers" style={{ ...inp, width: '100%' }} value={supplier} onChange={(event) => setSupplier(event.target.value)} />
			<datalist id="stock-edit-suppliers">{form.suppliers.map((item) => <option key={item} value={item} />)}</datalist>
		</>}
		{detail.kind === 'issue' && <><label style={label}>Причина</label><input style={{ ...inp, width: '100%' }} value={reason} onChange={(event) => setReason(event.target.value)} /></>}
		<label style={label}>Примечание</label>
		<input style={{ ...inp, width: '100%' }} value={note} onChange={(event) => setNote(event.target.value)} />
		<label style={label}>Товары</label>
		{canAdd && <div style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
			<input style={{ ...inp, flex: 1 }} placeholder="Найти товар для добавления" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void findItems(); } }} />
			<button type="button" style={btnGhost} disabled={searching} onClick={() => void findItems()}>{searching ? '…' : 'Найти'}</button>
		</div>}
		{results.length > 0 && <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid #e3e8ef', borderRadius: 7, marginBottom: 8 }}>
			{results.map((item) => <button key={item.productId} type="button" onClick={() => addItem(item)} style={{ display: 'block', width: '100%', padding: 8, border: 0, borderBottom: '1px solid #eef1f5', background: 'var(--app-surface)', textAlign: 'left', cursor: 'pointer' }}>{item.name || `#${item.productId}`}</button>)}
		</div>}
		<table style={{ width: '100%', borderCollapse: 'collapse' }}>
			<thead><tr><th style={cell}>Товар</th><th style={cell}>Кол-во</th><th style={cell}>Склад</th>{detail.kind === 'receipt' && <th style={cell}>Закупка, ₽</th>}<th style={cell} /></tr></thead>
			<tbody>{lines.map((line, index) => <tr key={line.rowId || `${line.productId}-${index}`}>
				<td style={cell}>{line.itemName || `#${line.productId}`}</td>
				<td style={cell}><input type="number" min="0.001" step="any" style={{ ...inp, width: 75 }} value={line.qty} onChange={(event) => updateLine(index, { qty: Number(event.target.value) })} /></td>
				<td style={cell}><select style={{ ...inp, maxWidth: 190 }} value={line.store} onChange={(event) => updateLine(index, { store: event.target.value })}>{stores.map((store) => <option key={store} value={store}>{store}</option>)}</select></td>
				{detail.kind === 'receipt' && <td style={cell}><input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={line.rate} onChange={(event) => updateLine(index, { rate: Number(event.target.value) })} /></td>}
				<td style={cell}><button type="button" style={btnGhost} onClick={() => removeLine(index)}>✕</button></td>
			</tr>)}</tbody>
		</table>
		{detail.kind === 'return' && <p style={{ color: 'var(--app-muted)', fontSize: 12 }}>В возврате можно исправить существующие позиции. Новую позицию оформите отдельным возвратом из сделки.</p>}
		{detail.kind === 'receipt' && !detail.allowAddLines && <p style={{ color: 'var(--app-muted)', fontSize: 12 }}>Состав оприходования связан с заказом поставщику. Новые позиции добавляются в самом заказе.</p>}
		{error && <p className="error">⛔ {error}</p>}
		<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
			<button type="button" style={btnGhost} disabled={busy} onClick={onCancel}>Отмена</button>
			<button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Исправляю…' : 'Сохранить корректировку'}</button>
		</div>
	</div>;
}
