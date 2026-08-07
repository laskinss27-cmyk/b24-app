import { useEffect, useState } from 'react';
import { type SupplyOrderRow } from './b24.js';

export function SupplyOrderNoteEditor({ order, onSave }: { order: SupplyOrderRow; onSave: (order: SupplyOrderRow, note: string) => Promise<void> }): JSX.Element {
	const [value, setValue] = useState(order.note);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const changed = value.trim() !== order.note.trim();

	async function save(): Promise<void> {
		if (!changed || saving) return;
		setSaving(true); setError('');
		try {
			await onSave(order, value);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Не удалось сохранить комментарий');
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="supply-order-common-note supply-order-note-editor">
			<label><b>Комментарий</b><textarea rows={2} maxLength={500} value={value} placeholder="Общий комментарий к заказу" onChange={(event) => setValue(event.target.value)} /></label>
			<button type="button" disabled={!changed || saving} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Сохранить'}</button>
			{error && <span className="error">{error}</span>}
		</div>
	);
}

export function SupplyOrderStoreEditor({
	order,
	stores,
	onSave,
}: {
	order: SupplyOrderRow;
	stores: string[];
	onSave: (order: SupplyOrderRow, toStore: string) => Promise<void>;
}): JSX.Element {
	const [value, setValue] = useState(order.toStore);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const hasTransfer = (order.transfers ?? []).some((transfer) => transfer.status !== 'canceled');
	const hasReceipt = (order.purchases ?? []).some((purchase) =>
		purchase.receipts.some((receipt) => receipt.docstatus === 1));
	const lockedReason = order.closed
		? 'Заявка уже выполнена.'
		: hasTransfer
			? 'По заявке уже создано перемещение. Сначала измени или отмени его.'
			: hasReceipt
				? 'По заявке уже проведён приход. Конечный склад менять нельзя.'
				: '';
	const options = [...new Set([order.toStore, ...stores].map((store) => store.trim()).filter(Boolean))];
	const changed = value.trim() !== order.toStore.trim();

	useEffect(() => {
		setValue(order.toStore);
		setError('');
	}, [order.requestKey, order.toStore]);

	async function save(): Promise<void> {
		if (!changed || saving || lockedReason || !value.trim()) return;
		setSaving(true);
		setError('');
		try {
			await onSave(order, value.trim());
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Не удалось изменить конечный склад');
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="supply-order-store-editor">
			<label><b>Конечный склад</b><select value={value} disabled={saving || Boolean(lockedReason)} onChange={(event) => { setValue(event.target.value); setError(''); }}><option value="">Выбери склад</option>{options.map((store) => <option key={store} value={store}>{store}</option>)}</select></label>
			<button type="button" disabled={!changed || !value.trim() || saving || Boolean(lockedReason)} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Изменить склад'}</button>
			{lockedReason && <span className="hint">{lockedReason}</span>}
			{error && <span className="error">{error}</span>}
		</div>
	);
}
