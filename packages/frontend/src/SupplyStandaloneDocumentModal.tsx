import { useEffect, useState } from 'react';
import { ProductBase } from './ProductBase.js';
import {
	createIssueDoc,
	createManualTransfer,
	createReceiptDoc,
	createStandaloneSupplyPurchase,
	fetchStockFormData,
} from './b24.js';
import { numericDraft, type NumericDraft } from './SupplyDocumentDetail.js';
import { SupplySupplierField } from './SupplySupplierField.js';

export type StandaloneDocumentKind = 'purchase' | 'transfer' | 'issue' | 'receipt';
interface StandaloneLine {
	productId: number;
	name: string;
	stocks: Record<string, number>;
	qty: NumericDraft;
	rate: NumericDraft;
	retail: NumericDraft;
}

export function SupplyStandaloneDocumentModal({ kind, suppliers, mock, onCreateSupplier, onClose, onDone }: { kind: StandaloneDocumentKind; suppliers: string[]; mock: boolean; onCreateSupplier: (name: string) => Promise<string>; onClose: () => void; onDone: (message: string, view: 'purchase' | 'receipt' | 'issue' | 'logistics') => void }): JSX.Element {
	const [stores, setStores] = useState<string[]>([]);
	const [fromStore, setFromStore] = useState('');
	const [toStore, setToStore] = useState('');
	const [supplier, setSupplier] = useState('');
	const [expectedAt, setExpectedAt] = useState(() => new Date().toISOString().slice(0, 10));
	const [reason, setReason] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<StandaloneLine[]>([]);
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	useEffect(() => {
		if (mock) {
			setStores(['Максидом Дунайский 64', 'Максидом Богатырский 15', 'Максидом ул. Фаворского 12']);
			return;
		}
		void fetchStockFormData().then((data) => setStores(data.stores.filter((name) => !name.toLowerCase().includes('транзит')))).catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [mock]);

	const addPickedLines = (items: Array<{ productId: number; name: string; quantity: number; price: number; purchasePrice?: number; stocks?: Record<string, number> }>): void => {
		setLines((current) => {
			const next = [...current];
			for (const item of items) {
				const index = next.findIndex((line) => line.productId === item.productId);
				if (index >= 0) {
					const existing = next[index];
					if (existing) next[index] = { ...existing, stocks: item.stocks ?? existing.stocks, qty: Number(existing.qty || 0) + item.quantity };
				} else {
					next.push({
						productId: item.productId,
						name: item.name,
						stocks: item.stocks ?? {},
						qty: item.quantity,
						rate: kind === 'purchase' || kind === 'receipt' ? Number(item.purchasePrice ?? 0) : 0,
						retail: kind === 'receipt' ? Number(item.price ?? 0) : 0,
					});
				}
			}
			return next;
		});
	};

	const patchLine = (productId: number, patch: Partial<Pick<StandaloneLine, 'qty' | 'rate' | 'retail'>>): void => {
		setLines((current) => current.map((line) => line.productId === productId ? { ...line, ...patch } : line));
	};

	const submit = async (): Promise<void> => {
		setError('');
		const validLines = lines.filter((line) => Number(line.qty || 0) > 0);
		if (!validLines.length) { setError('Добавь хотя бы одну позицию.'); return; }
		if (kind === 'purchase' && (!supplier.trim() || supplier.trim() === 'Поставщик не выбран')) { setError('Выбери поставщика.'); return; }
		if (kind === 'receipt' && !toStore) { setError('Выбери склад оприходования.'); return; }
		if (kind === 'issue' && !fromStore) { setError('Выбери склад списания.'); return; }
		if (kind === 'transfer') {
			if (!fromStore || !toStore) { setError('Выбери склад отправки и склад получения.'); return; }
			if (fromStore === toStore) { setError('Склады отправки и получения должны отличаться.'); return; }
		}
		if (kind === 'transfer' || kind === 'issue') {
			const unavailable = validLines.find((line) => Number(line.qty || 0) > Number(line.stocks[fromStore] ?? 0));
			if (unavailable) { setError(`На складе «${fromStore}» доступно ${Number(unavailable.stocks[fromStore] ?? 0)}: ${unavailable.name}.`); return; }
		}
		setBusy(true);
		try {
			if (kind === 'purchase') {
				const name = await createStandaloneSupplyPurchase(supplier.trim(), expectedAt, validLines.map((line) => ({ productId: line.productId, itemName: line.name, qty: Number(line.qty), rate: Number(line.rate || 0) })));
				onDone(`${name}: создан самостоятельный черновик.`, 'purchase');
				return;
			}
			if (kind === 'receipt') {
				const name = await createReceiptDoc({
					toStore,
					...(supplier.trim() && supplier.trim() !== 'Поставщик не выбран' ? { supplier: supplier.trim() } : {}),
					...(note.trim() ? { note: note.trim() } : {}),
					lines: validLines.map((line) => ({ productId: line.productId, qty: Number(line.qty), purchase: Number(line.rate || 0), retail: Number(line.retail || 0) })),
				});
				onDone(`${name}: создан черновик оприходования.`, 'receipt');
				return;
			}
			if (kind === 'issue') {
				const name = await createIssueDoc({
					fromStore,
					...(reason.trim() ? { reason: reason.trim() } : {}),
					...(note.trim() ? { note: note.trim() } : {}),
					lines: validLines.map((line) => ({ productId: line.productId, qty: Number(line.qty) })),
				});
				onDone(`${name}: создан черновик списания.`, 'issue');
				return;
			}
			const transfer = await createManualTransfer({ fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines.map((line) => ({ productId: line.productId, name: line.name, qty: Number(line.qty) })) });
			onDone(`Перемещение #${transfer.id}: создан черновик.`, 'logistics');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const documentTitle = kind === 'purchase' ? 'Заявка поставщику'
		: kind === 'transfer' ? 'Перемещение'
			: kind === 'issue' ? 'Списание'
				: 'Оприходование';
	const pickerTitle = kind === 'purchase' ? 'Подобрать товары в заявку поставщику'
		: kind === 'transfer' ? 'Подобрать товары для перемещения'
			: kind === 'issue' ? 'Подобрать товары для списания'
				: 'Подобрать товары для оприходования';

	if (pickingProducts) {
		return (
			<div className="supply-product-picker-overlay">
				<ProductBase picker={{
					title: pickerTitle,
					kindFilter: 'goods',
					onlyStockDefault: false,
					onCancel: () => setPickingProducts(false),
					onDone: async (items) => {
						addPickedLines(items);
						setPickingProducts(false);
					},
				}} />
			</div>
		);
	}

	return (
		<div className="supply-proto-overlay">
			<section className="supply-proto-modal supply-standalone-modal" role="dialog" aria-modal="true" aria-label={`Новое ${documentTitle.toLowerCase()}`}>
				<header><div><h2>{documentTitle}</h2><p>Самостоятельный документ без сделки и заявки.</p></div><button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></header>
				<div className="supply-standalone-fields">
					{kind === 'purchase' ? <>
						<SupplySupplierField id="standalone-purchase-supplier" label="Поставщик" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} />
						<label>Ожидаемая дата<input type="date" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} /></label>
					</> : kind === 'transfer' ? <>
						<label>Склад отправки<select value={fromStore} onChange={(event) => setFromStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<label>Склад получения<select value={toStore} onChange={(event) => setToStore(event.target.value)}><option value="">Выбери склад</option>{stores.filter((name) => name !== fromStore).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
					</> : kind === 'issue' ? <>
						<label>Склад списания<select value={fromStore} onChange={(event) => setFromStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<label>Причина<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Брак, недостача, внутренние нужды" /></label>
					</> : <>
						<label>Склад оприходования<select value={toStore} onChange={(event) => setToStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<SupplySupplierField id="standalone-receipt-supplier" label="Поставщик (необязательно)" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} />
					</>}
				</div>
				<div className="supply-standalone-product-actions">
					<button type="button" onClick={() => setPickingProducts(true)}>Подобрать товары</button>
					<span>{lines.length ? `Выбрано позиций: ${lines.length}` : 'Позиции ещё не выбраны'}</span>
				</div>
				<div className="supply-document-lines supply-standalone-lines">
					<table><thead><tr><th>Позиция</th><th>Количество</th>{kind === 'purchase' && <th>Цена</th>}{kind === 'receipt' && <><th>Закупочная цена</th><th>Розничная цена</th></>}<th aria-label="Удалить" /></tr></thead><tbody>
						{lines.length === 0 ? <tr><td colSpan={kind === 'receipt' ? 5 : kind === 'purchase' ? 4 : 3} className="empty">Позиции не добавлены.</td></tr> : lines.map((line) => <tr key={line.productId}><td><b>{line.name}</b><small>#{line.productId}{(kind === 'transfer' || kind === 'issue') && fromStore ? ` · доступно ${Number(line.stocks[fromStore] ?? 0)}` : ''}</small></td><td><input type="number" min="0" step="any" value={line.qty} onChange={(event) => patchLine(line.productId, { qty: numericDraft(event.target.value) })} /></td>{(kind === 'purchase' || kind === 'receipt') && <td><input type="number" min="0" step="any" value={line.rate} onChange={(event) => patchLine(line.productId, { rate: numericDraft(event.target.value) })} /></td>}{kind === 'receipt' && <td><input type="number" min="0" step="any" value={line.retail} onChange={(event) => patchLine(line.productId, { retail: numericDraft(event.target.value) })} /></td>}<td><button className="supply-document-remove-line" type="button" title="Удалить позицию" aria-label="Удалить позицию" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td></tr>)}
					</tbody></table>
				</div>
				{(kind === 'transfer' || kind === 'issue' || kind === 'receipt') && <label className="supply-standalone-search">Комментарий<input value={note} onChange={(event) => setNote(event.target.value)} /></label>}
				{error && <div className="supply-standalone-error">{error}</div>}
				<footer><button type="button" onClick={onClose}>Отмена</button><button className="primary" type="button" disabled={busy} onClick={() => void submit()}>{busy ? 'Создаю...' : 'Создать'}</button></footer>
			</section>
		</div>
	);
}
