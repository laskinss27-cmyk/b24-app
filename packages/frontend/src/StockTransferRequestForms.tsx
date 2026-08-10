import { useState, type CSSProperties } from 'react';
import { ProductBase, type ProductPickItem } from './ProductBase.js';
import {
	convertTransferRequest, createSupplyTtRequest, createTransferRequest,
	type SupplyRequestLineDto, type TransferRequestDoc,
} from './b24.js';
import type { StockForm } from './StockWorkspaceTypes.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const fieldLabel: CSSProperties = { fontSize: 12, color: '#7a8699', display: 'block', margin: '8px 0 4px' };
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '36px 16px', zIndex: 1000, overflow: 'auto' };
const modalCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 700, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)' };
const storeSelect = (value: string, onChange: (v: string) => void, stores: string[], placeholder: string): JSX.Element => (
	<select style={{ ...inp, width: '100%' }} value={value} onChange={(e) => onChange(e.target.value)}>
		<option value="">{placeholder}</option>
		{stores.map((s) => <option key={s} value={s}>{s}</option>)}
	</select>
);

interface SimpleLine { productId: number; name: string; qty: number }
interface SupplyTtLine { productId: number | null; name: string; qty: number | ''; link: string; note: string }


export function SupplyTtRequestForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [toStore, setToStore] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SupplyTtLine[]>([]);
	const [manualName, setManualName] = useState('');
	const [manualQty, setManualQty] = useState<number | ''>(1);
	const [manualLink, setManualLink] = useState('');
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const addPicked = (items: ProductPickItem[]): void => setLines((current) => {
		const next = [...current];
		for (const item of items) {
			const index = next.findIndex((line) => line.productId === item.productId);
			if (index >= 0) {
				const existing = next[index];
				if (existing) next[index] = { ...existing, qty: Number(existing.qty || 0) + item.quantity };
			} else next.push({ productId: item.productId, name: item.name, qty: item.quantity, link: '', note: '' });
		}
		return next;
	});
	const addManual = (): void => {
		const name = manualName.trim();
		const qty = Number(manualQty);
		if (!name || !Number.isFinite(qty) || qty <= 0) return;
		setLines((current) => [...current, { productId: null, name, qty, link: manualLink.trim(), note: '' }]);
		setManualName('');
		setManualQty(1);
		setManualLink('');
	};
	const save = async (): Promise<void> => {
		setErr(null);
		const validLines: SupplyRequestLineDto[] = lines.map((line) => ({
			productId: line.productId,
			name: line.name.trim(),
			qty: Number(line.qty),
			...(line.link.trim() ? { link: line.link.trim() } : {}),
			...(line.note.trim() ? { note: line.note.trim() } : {}),
		})).filter((line) => line.qty > 0 && (line.productId || line.name));
		if (!toStore) { setErr('выбери склад, куда нужен товар'); return; }
		if (!validLines.length) { setErr('добавь хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createSupplyTtRequest({ toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines });
			onDone();
		} catch (error) { setErr(errText(error)); }
		finally { setBusy(false); }
	};
	if (pickingProducts) return <div className="supply-product-picker-overlay"><ProductBase picker={{ title: 'Товары для заявки снабжению', kindFilter: 'goods', onlyStockDefault: false, onCancel: () => setPickingProducts(false), onDone: async (items) => { addPicked(items); setPickingProducts(false); } }} /></div>;
	return (
		<div style={overlay}>
			<div style={{ ...modalCard, maxWidth: 880 }}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Заявка снабжению</h2>
				<label style={fieldLabel}>Склад, куда нужен товар</label>
				<div style={{ maxWidth: 360 }}>{storeSelect(toStore, setToStore, form.stores, '— выбери склад —')}</div>
				<label style={fieldLabel}>Позиции</label>
				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
					<button style={btnGhost} onClick={() => setPickingProducts(true)}>Выбрать из базы</button>
					<input style={{ ...inp, width: 260 }} placeholder="или написать вручную" value={manualName} onChange={(event) => setManualName(event.target.value)} />
					<input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={manualQty} onChange={(event) => setManualQty(event.target.value === '' ? '' : Number(event.target.value))} />
					<input style={{ ...inp, width: 260 }} placeholder="ссылка, если есть" value={manualLink} onChange={(event) => setManualLink(event.target.value)} />
					<button style={btnGhost} onClick={addManual}>Добавить строку</button>
				</div>
				{lines.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}><thead><tr><th style={TH}>Позиция</th><th style={TH}>Кол-во</th><th style={TH}>Ссылка</th><th style={TH}>Комментарий</th><th style={TH}></th></tr></thead><tbody>{lines.map((line, index) => <tr key={`${line.productId ?? 'manual'}-${index}`}>
					<td style={TD}><b>{line.name}</b>{line.productId ? <div style={{ color: '#7a8699', fontSize: 12 }}>#{line.productId}</div> : null}</td>
					<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 80 }} value={line.qty} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, qty: event.target.value === '' ? '' : Number(event.target.value) } : row))} /></td>
					<td style={TD}><input style={{ ...inp, width: 180 }} value={line.link} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, link: event.target.value } : row))} /></td>
					<td style={TD}><input style={{ ...inp, width: 220 }} value={line.note} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, note: event.target.value } : row))} /></td>
					<td style={TD}><button style={btnGhost} title="Удалить" onClick={() => setLines((current) => current.filter((_, rowIndex) => rowIndex !== index))}>×</button></td>
				</tr>)}</tbody></table>}
				<label style={fieldLabel}>Общий комментарий</label>
				<textarea style={{ ...inp, boxSizing: 'border-box', width: '100%', minHeight: 70, resize: 'vertical' }} value={note} onChange={(event) => setNote(event.target.value)} />
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}><button style={btnGhost} disabled={busy} onClick={onClose}>Отмена</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать заявку'}</button></div>
			</div>
		</div>
	);
}

export function TransferRequestForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState('');
	const [toStore, setToStore] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const add = (items: ProductPickItem[]): void => setLines((current) => {
		const next = [...current];
		for (const item of items) {
			const index = next.findIndex((line) => line.productId === item.productId);
			if (index >= 0) {
				const existing = next[index];
				if (existing) next[index] = { ...existing, qty: existing.qty + item.quantity };
			} else next.push({ productId: item.productId, name: item.name, qty: item.quantity });
		}
		return next;
	});
	const save = async (): Promise<void> => {
		setErr(null);
		const validLines = lines.filter((line) => line.qty > 0);
		if (!fromStore || !toStore) { setErr('выберите склад отправки и склад получения'); return; }
		if (fromStore === toStore) { setErr('склады должны отличаться'); return; }
		if (!validLines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createTransferRequest({ fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines });
			onDone();
		} catch (error) { setErr(errText(error)); }
		finally { setBusy(false); }
	};
	if (pickingProducts) return <div className="supply-product-picker-overlay"><ProductBase picker={{ title: 'Подобрать товары в заказ на перемещение', kindFilter: 'goods', onlyStockDefault: false, onCancel: () => setPickingProducts(false), onDone: async (items) => { add(items); setPickingProducts(false); } }} /></div>;
	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Заказ на перемещение</h2>
				<div style={{ display: 'flex', gap: 12 }}>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Откуда</label>{storeSelect(fromStore, setFromStore, form.stores, '— склад-источник —')}</div>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Куда</label>{storeSelect(toStore, setToStore, form.stores.filter((store) => store !== fromStore), '— склад-получатель —')}</div>
				</div>
				<label style={fieldLabel}>Позиции</label>
				<button style={btnGhost} onClick={() => setPickingProducts(true)}>Подобрать товары</button>
				{lines.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}><thead><tr><th style={TH}>Товар</th><th style={TH}>Количество</th><th style={TH}></th></tr></thead><tbody>{lines.map((line) => <tr key={line.productId}>
					<td style={TD}>{line.name}</td><td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 80 }} value={line.qty} onChange={(event) => setLines((current) => current.map((row) => row.productId === line.productId ? { ...row, qty: Number(event.target.value) } : row))} /></td><td style={TD}><button style={btnGhost} title="Удалить" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td>
				</tr>)}</tbody></table>}
				<label style={fieldLabel}>Комментарий</label>
				<textarea style={{ ...inp, boxSizing: 'border-box', width: '100%', minHeight: 70, resize: 'vertical' }} value={note} onChange={(event) => setNote(event.target.value)} />
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}><button style={btnGhost} onClick={onClose}>Отмена</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать заказ'}</button></div>
			</div>
		</div>
	);
}

export function ConvertTransferRequestForm({ form, request, onClose, onDone }: { form: StockForm; request: TransferRequestDoc; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState(request.fromStore);
	const [toStore, setToStore] = useState(request.toStore);
	const [note, setNote] = useState(request.note);
	const [lines, setLines] = useState<SimpleLine[]>(request.lines.map((line) => ({ productId: line.productId, name: line.name, qty: line.qty })));
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const add = (items: ProductPickItem[]): void => setLines((current) => {
		const next = [...current];
		for (const item of items) {
			const index = next.findIndex((line) => line.productId === item.productId);
			if (index >= 0) {
				const existing = next[index];
				if (existing) next[index] = { ...existing, qty: existing.qty + item.quantity };
			} else next.push({ productId: item.productId, name: item.name, qty: item.quantity });
		}
		return next;
	});
	const save = async (): Promise<void> => {
		setErr(null);
		const validLines = lines.filter((line) => line.qty > 0);
		if (!fromStore || !toStore || fromStore === toStore) { setErr('выберите разные склады'); return; }
		if (!validLines.length) { setErr('в перемещении должна остаться хотя бы одна позиция'); return; }
		setBusy(true);
		try {
			await convertTransferRequest(request.id, { fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines });
			onDone();
		} catch (error) { setErr(errText(error)); }
		finally { setBusy(false); }
	};
	if (pickingProducts) return <div className="supply-product-picker-overlay"><ProductBase picker={{ title: `Товары для перемещения по заказу #${request.id}`, kindFilter: 'goods', onlyStockDefault: false, onCancel: () => setPickingProducts(false), onDone: async (items) => { add(items); setPickingProducts(false); } }} /></div>;
	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 3px' }}>Перемещение по заказу #{request.id}</h2>
				<div style={{ color: '#7a8699', fontSize: 12, marginBottom: 8 }}>{request.createdByName} · {request.createdAt ? new Date(request.createdAt).toLocaleString('ru-RU') : ''}</div>
				<div style={{ display: 'flex', gap: 12 }}>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Откуда</label>{storeSelect(fromStore, setFromStore, form.stores, '— склад-источник —')}</div>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Куда</label>{storeSelect(toStore, setToStore, form.stores.filter((store) => store !== fromStore), '— склад-получатель —')}</div>
				</div>
				<label style={fieldLabel}>Позиции</label>
				<button style={btnGhost} onClick={() => setPickingProducts(true)}>Подобрать товары</button>
				<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}><thead><tr><th style={TH}>Товар</th><th style={TH}>Количество</th><th style={TH}></th></tr></thead><tbody>{lines.map((line) => <tr key={line.productId}>
					<td style={TD}>{line.name}</td><td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 80 }} value={line.qty} onChange={(event) => setLines((current) => current.map((row) => row.productId === line.productId ? { ...row, qty: Number(event.target.value) } : row))} /></td><td style={TD}><button style={btnGhost} title="Удалить" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td>
				</tr>)}</tbody></table>
				<label style={fieldLabel}>Комментарий</label>
				<textarea style={{ ...inp, boxSizing: 'border-box', width: '100%', minHeight: 70, resize: 'vertical' }} value={note} onChange={(event) => setNote(event.target.value)} />
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}><button style={btnGhost} disabled={busy} onClick={onClose}>Отмена</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать перемещение'}</button></div>
			</div>
		</div>
	);
}
