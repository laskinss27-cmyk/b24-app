import { useState, type CSSProperties } from 'react';
import {
	createIssueDoc, createManualTransfer, createReceiptDoc, createStockProduct, searchStockItems,
	type StockItem,
} from './b24.js';
import { StockHint, stockEntries } from './StockProductFilter.js';
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

/** Пикер позиций: поиск по каталогу ядра → клик добавляет в строки. */
function ItemPicker({ onPick }: { onPick: (it: StockItem) => void }): JSX.Element {
	const [q, setQ] = useState('');
	const [res, setRes] = useState<StockItem[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const search = async (): Promise<void> => {
		if (q.trim().length < 1) return;
		setBusy(true); setErr(null);
		try { setRes(await searchStockItems(q)); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};
	return (
		<div>
			<div style={{ display: 'flex', gap: 8 }}>
				<input style={{ ...inp, flex: 1 }} placeholder="🔎 товар: id / название / артикул" value={q}
					onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
				<button style={btnGhost} disabled={busy} onClick={() => void search()}>{busy ? '…' : 'Найти'}</button>
			</div>
			{err && <p className="error" style={{ marginTop: 6 }}>⛔ {err}</p>}
			{res && (res.length ? (
				<div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #e3e8ef', borderRadius: 8, marginTop: 6 }}>
					{res.map((it) => (
						<div key={it.productId} onClick={() => onPick(it)} style={{ padding: 8, borderBottom: '1px solid #f0f2f5', cursor: 'pointer' }}>
							<b>{it.name || ('#' + it.productId)}</b> <span style={{ color: '#7a8699', fontSize: 12 }}>{[it.article, it.brand, 'id ' + it.productId].filter(Boolean).join(' · ')}</span>
							<div><StockHint it={it} /></div>
						</div>
					))}
				</div>
			) : <p className="empty" style={{ marginTop: 6 }}>Ничего не найдено.</p>)}
		</div>
	);
}

interface ReceiptLine { productId: number; name: string; qty: number; purchase: number; retail: number }

/** Под-форma «Добавить товар» (логика 1С): поиск → выбор → кол-во (+цены для прихода) → «Добавить». */
function AddItemModal({ withPrices, highlightStore, onAdd, onClose }: { withPrices: boolean; highlightStore?: string; onAdd: (it: ReceiptLine) => void; onClose: () => void }): JSX.Element {
	const [sel, setSel] = useState<StockItem | null>(null);
	const [qty, setQty] = useState(1);
	const [purchase, setPurchase] = useState(0);
	const [retail, setRetail] = useState(0);
	const [err, setErr] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const [cbusy, setCbusy] = useState(false);
	const confirm = (): void => {
		if (!sel) { setErr('найди и выбери товар'); return; }
		if (!(qty > 0)) { setErr('кол-во должно быть больше 0'); return; }
		onAdd({ productId: sel.productId, name: sel.name || ('#' + sel.productId), qty, purchase, retail });
		onClose();
	};
	const createNew = async (): Promise<void> => {
		setErr(null);
		if (newName.trim().length < 2) { setErr('введите название нового товара'); return; }
		setCbusy(true);
		try { const it = await createStockProduct(newName.trim()); setSel(it); setCreating(false); }
		catch (e) { setErr(errText(e)); } finally { setCbusy(false); }
	};
	return (
		<div style={{ ...overlay, zIndex: 1100 }}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 16, margin: '0 0 10px' }}>Добавить товар</h2>
				{!sel ? (creating ? (
					<div>
						<label style={fieldLabel}>Название нового товара</label>
						<input autoFocus style={{ ...inp, width: '100%' }} placeholder="например: Видеорегистратор XYZ-8" value={newName} onChange={(e) => setNewName(e.target.value)} />
						<p style={{ fontSize: 12, color: '#7a8699', margin: '4px 0 0' }}>Заведём в каталоге Б24 и в ядре. Цены укажешь в приходе.</p>
						<div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
							<button style={btnGhost} onClick={() => setCreating(false)}>← назад к поиску</button>
							<button className="btn-primary" disabled={cbusy} onClick={() => void createNew()}>{cbusy ? '…' : 'Создать товар'}</button>
						</div>
					</div>
				) : (
					<>
						<ItemPicker onPick={setSel} />
						<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Нет в базе? <a href="#" onClick={(e) => { e.preventDefault(); setCreating(true); }} style={{ color: '#185fa5' }}>Создать новый товар</a></p>
					</>
				)) : (
					<>
						<div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 6px' }}>
							<span>✅ <b>{sel.name || ('#' + sel.productId)}</b> <span style={{ color: '#7a8699', fontSize: 12 }}>id {sel.productId}</span></span>
							<button style={btnGhost} onClick={() => setSel(null)}>сменить</button>
						</div>
						<div style={{ fontSize: 13, margin: '0 0 4px' }}>
							Остатки: {stockEntries(sel).length
								? stockEntries(sel).map(([s, q]) => <span key={s} style={{ marginRight: 10, ...(s === highlightStore ? { fontWeight: 700, color: '#185fa5' } : {}) }}>{s}: {q}</span>)
								: <span style={{ color: '#c0392b' }}>нет на складах</span>}
						</div>
						{highlightStore ? <div style={{ fontSize: 12, color: (sel.stocks?.[highlightStore] ?? 0) < qty ? '#c0392b' : '#7a8699', marginBottom: 4 }}>На «{highlightStore}»: {sel.stocks?.[highlightStore] ?? 0}{(sel.stocks?.[highlightStore] ?? 0) < qty ? ` — меньше, чем вводишь (${qty})` : ''}</div> : null}
						<label style={fieldLabel}>Количество</label>
						<input type="number" min="0" step="any" autoFocus style={{ ...inp, width: 120 }} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
						{withPrices && (
							<div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
								<div><label style={fieldLabel}>Закупка ₽</label><input type="number" min="0" step="any" style={{ ...inp, width: 120 }} value={purchase} onChange={(e) => setPurchase(Number(e.target.value))} /></div>
								<div><label style={fieldLabel}>Розница ₽ (необяз.)</label><input type="number" min="0" step="any" style={{ ...inp, width: 120 }} value={retail} onChange={(e) => setRetail(Number(e.target.value))} /></div>
							</div>
						)}
					</>
				)}
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={!sel} onClick={confirm}>Добавить</button>
				</div>
			</div>
		</div>
	);
}

export function ReceiptForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [toStore, setToStore] = useState('');
	const [supplier, setSupplier] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<ReceiptLine[]>([]);
	const [addOpen, setAddOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: ReceiptLine): void => setLines((ls) => ls.some((l) => l.productId === it.productId)
		? ls.map((l) => l.productId === it.productId ? { ...l, qty: l.qty + it.qty, purchase: it.purchase || l.purchase, retail: it.retail || l.retail } : l)
		: [...ls, it]);
	const upd = (pid: number, patch: Partial<ReceiptLine>): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, ...patch } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!toStore) { setErr('выберите склад прихода'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		const sup = supplier.trim();
		setBusy(true);
		try {
			await createReceiptDoc({ toStore, ...(sup ? { supplier: sup } : {}), ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, purchase: l.purchase, retail: l.retail })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Приход (оприходование)</h2>
				<label style={fieldLabel}>Склад прихода</label>
				{storeSelect(toStore, setToStore, form.stores, '— выберите склад —')}
				<label style={fieldLabel}>Поставщик (необязательно)</label>
				<input list="stock-suppliers" style={{ ...inp, width: '100%' }} placeholder="выбери из списка или впиши нового" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
				<datalist id="stock-suppliers">{form.suppliers.map((s) => <option key={s} value={s} />)}</datalist>
				<p style={{ fontSize: 12, color: '#7a8699', margin: '4px 0 0' }}>Список — контрагенты Б24 (воронка «Поставщики»). Нового можно вписать — заведём в ядре. Пусто → «Б24 Снабжение».</p>
				<label style={fieldLabel}>Товары</label>
				<button style={btnGhost} onClick={() => setAddOpen(true)}>➕ Добавить товар</button>
				{lines.length > 0 && (
					<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
						<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}>Закупка ₽</th><th style={TH}>Розница ₽</th><th style={TH}></th></tr></thead>
						<tbody>
							{lines.map((l) => (
								<tr key={l.productId}>
									<td style={TD}>{l.name}</td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 70 }} value={l.qty} onChange={(e) => upd(l.productId, { qty: Number(e.target.value) })} /></td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={l.purchase} onChange={(e) => upd(l.productId, { purchase: Number(e.target.value) })} /></td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={l.retail} onChange={(e) => upd(l.productId, { retail: Number(e.target.value) })} placeholder="—" /></td>
									<td style={TD}><button style={btnGhost} onClick={() => del(l.productId)}>✕</button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<label style={fieldLabel}>Примечание (необязательно)</label>
				<input style={{ ...inp, width: '100%' }} placeholder="любой комментарий" value={note} onChange={(e) => setNote(e.target.value)} />
				<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Розница (если заполнена) уйдёт в каталог Б24. Пусто — цену не трогаем.</p>
				{addOpen && <AddItemModal withPrices onAdd={add} onClose={() => setAddOpen(false)} />}
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать черновик'}</button>
				</div>
			</div>
		</div>
	);
}

interface SimpleLine { productId: number; name: string; qty: number }
export function IssueForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState('');
	const [reason, setReason] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [addOpen, setAddOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: ReceiptLine): void => setLines((ls) => ls.some((l) => l.productId === it.productId)
		? ls.map((l) => l.productId === it.productId ? { ...l, qty: l.qty + it.qty } : l)
		: [...ls, { productId: it.productId, name: it.name, qty: it.qty }]);
	const upd = (pid: number, qty: number): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, qty } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!fromStore) { setErr('выберите склад списания'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createIssueDoc({ fromStore, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Списание</h2>
				<label style={fieldLabel}>Склад списания</label>
				{storeSelect(fromStore, setFromStore, form.stores, '— выберите склад —')}
				<label style={fieldLabel}>Причина</label>
				<input style={{ ...inp, width: '100%' }} placeholder="например: брак, бой, недостача" value={reason} onChange={(e) => setReason(e.target.value)} />
				{addOpen && <AddItemModal withPrices={false} {...(fromStore ? { highlightStore: fromStore } : {})} onAdd={add} onClose={() => setAddOpen(false)} />}
				<label style={fieldLabel}>Примечание (необязательно)</label>
				<input style={{ ...inp, width: '100%' }} placeholder="любой комментарий" value={note} onChange={(e) => setNote(e.target.value)} />
				<label style={fieldLabel}>Товары</label>
				<button style={btnGhost} onClick={() => setAddOpen(true)}>➕ Добавить товар</button>
				{lines.length > 0 && (
					<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
						<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}></th></tr></thead>
						<tbody>
							{lines.map((l) => (
								<tr key={l.productId}>
									<td style={TD}>{l.name}</td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 70 }} value={l.qty} onChange={(e) => upd(l.productId, Number(e.target.value))} /></td>
									<td style={TD}><button style={btnGhost} onClick={() => del(l.productId)}>✕</button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать черновик'}</button>
				</div>
			</div>
		</div>
	);
}

export function TransferForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState('');
	const [toStore, setToStore] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [addOpen, setAddOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: ReceiptLine): void => setLines((ls) => ls.some((l) => l.productId === it.productId)
		? ls.map((l) => l.productId === it.productId ? { ...l, qty: l.qty + it.qty } : l)
		: [...ls, { productId: it.productId, name: it.name, qty: it.qty }]);
	const upd = (pid: number, qty: number): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, qty } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!fromStore || !toStore) { setErr('выберите оба склада'); return; }
		if (fromStore === toStore) { setErr('склады «откуда» и «куда» должны отличаться'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createManualTransfer({ fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Перемещение</h2>
				<div style={{ display: 'flex', gap: 12 }}>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Откуда</label>{storeSelect(fromStore, setFromStore, form.stores, '— склад-источник —')}</div>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Куда</label>{storeSelect(toStore, setToStore, form.stores, '— склад-получатель —')}</div>
				</div>
				<label style={fieldLabel}>Товары</label>
				<button style={btnGhost} onClick={() => setAddOpen(true)}>➕ Добавить товар</button>
				{lines.length > 0 && (
					<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
						<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}></th></tr></thead>
						<tbody>
							{lines.map((l) => (
								<tr key={l.productId}>
									<td style={TD}>{l.name}</td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 70 }} value={l.qty} onChange={(e) => upd(l.productId, Number(e.target.value))} /></td>
									<td style={TD}><button style={btnGhost} onClick={() => del(l.productId)}>✕</button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<label style={fieldLabel}>Примечание (необязательно)</label>
				<input style={{ ...inp, width: '100%' }} placeholder="любой комментарий" value={note} onChange={(e) => setNote(e.target.value)} />
				<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Создаётся статус «Запрошено». Снабжение проведёт «В пути» → «Получено» (честный транзит).</p>
				{addOpen && <AddItemModal withPrices={false} {...(fromStore ? { highlightStore: fromStore } : {})} onAdd={add} onClose={() => setAddOpen(false)} />}
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать'}</button>
				</div>
			</div>
		</div>
	);
}
