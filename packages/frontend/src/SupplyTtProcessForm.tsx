import { useState } from 'react';
import { ProductBase } from './ProductBase.js';
import { processSupplyTtRequest } from './stock-transfers.js';
import type { TransferRequestDoc } from './stock-transfer-types.js';

export function SupplyTtProcessForm({ request, stores, onClose, onDone }: { request: TransferRequestDoc; stores: string[]; onClose(): void; onDone(request: TransferRequestDoc): void }): JSX.Element {
	const [toStore, setToStore] = useState(request.toStore);
	const [deadline, setDeadline] = useState('');
	const [products, setProducts] = useState(request.supplyLines.map(line => ({ id: line.productId, name: line.name })));
	const [picking, setPicking] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const reconciling = Boolean(request.supplyHandoff);
	const save = async (): Promise<void> => {
		setError(''); setBusy(true);
		try { onDone(await processSupplyTtRequest(request.id, { toStore, deadline, productIds: products.map(p => p.id ?? 0) })); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
		finally { setBusy(false); }
	};
	if (picking !== null) return <div className="supply-product-picker-overlay"><ProductBase picker={{ title: `Выберите товар для «${request.supplyLines[picking]?.name}»`, kindFilter: 'goods', onlyStockDefault: false, onCancel: () => setPicking(null), onDone: async items => {
		if (items.length !== 1) { setError('Для одной позиции выберите ровно один товар'); setPicking(null); return; }
		const item = items[0]!;
		setProducts(current => current.map((row, index) => index === picking ? { id: item.productId, name: item.name } : row)); setPicking(null); setError('');
	} }} /></div>;
	return <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(20,30,50,.4)', overflow: 'auto', padding: '36px 16px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
		<div role="dialog" aria-label={`Обработка заявки #${request.id}`} style={{ background: 'white', borderRadius: 12, padding: 20, width: '100%', maxWidth: 900 }}>
			<h2>Обработка заявки #{request.id}</h2>
			<p>После передачи заявка откроется в «Обеспечение и заказы». Там можно распределить товары между закупкой и перемещением и отслеживать исполнение.</p>
			{request.note && <p><b>Комментарий заявки:</b> {request.note}</p>}
			{reconciling ? <p>Передача уже начата. Проверим ранее созданный документ; повторная заявка не создаётся.</p> : <>
				<div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
					<label>Конечный склад <select value={toStore} onChange={e => setToStore(e.target.value)}><option value="">Выберите склад</option>{stores.map(store => <option key={store}>{store}</option>)}</select></label>
					<label>Крайняя дата поставки <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} /></label>
				</div>
				<table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={{ textAlign: 'left' }}>Исходная позиция</th><th>Количество</th><th style={{ textAlign: 'left' }}>Товар каталога</th><th /></tr></thead><tbody>{request.supplyLines.map((line, index) => <tr key={index}>
					<td style={{ padding: 8, maxWidth: 320 }}>{line.name}{line.link && <div><a href={line.link} target="_blank" rel="noreferrer">Ссылка из заявки</a></div>}{line.note && <small>{line.note}</small>}</td>
					<td style={{ textAlign: 'center' }}>{line.qty}</td><td style={{ padding: 8 }}>{products[index]?.id ? products[index]!.name : 'Нужно выбрать товар'}</td>
					<td><button disabled={busy} onClick={() => setPicking(index)}>{products[index]?.id ? 'Заменить' : 'Выбрать'}</button></td>
				</tr>)}</tbody></table>
			</>}
			{error && <p role="alert" className="error">{error}</p>}
			<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
				<button disabled={busy} onClick={onClose}>Закрыть</button>
				<button className="btn-primary" disabled={busy || (!reconciling && (!stores.includes(toStore) || !deadline || products.some(p => !p.id)))} onClick={() => void save()}>{busy ? 'Проверяем…' : reconciling ? 'Проверить результат передачи' : 'Передать в обеспечение'}</button>
			</div>
		</div>
	</div>;
}
