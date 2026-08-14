import { useEffect, useState } from 'react';
import { searchProducts, updateSupplyRequestLine, type SupplyOrderItem, type SupplyOrderRow } from './b24.js';

export function SupplyRequestLineEditor({
	order,
	item,
	onSaved,
}: {
	order: SupplyOrderRow;
	item: SupplyOrderItem;
	onSaved: () => Promise<void>;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState(item.itemName);
	const [selected, setSelected] = useState({ id: item.productId, name: item.itemName });
	const [qty, setQty] = useState(String(item.requestedQty ?? item.qty));
	const [results, setResults] = useState<Array<{ id: number; name: string }>>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const minimum = Number(item.allocatedQty ?? 0);

	useEffect(() => {
		if (!open || query.trim().length < 2 || query.trim() === selected.name) { setResults([]); return; }
		let alive = true;
		const timer = window.setTimeout(() => {
			void searchProducts(query).then((rows) => { if (alive) setResults(rows.slice(0, 12)); }).catch(() => { if (alive) setResults([]); });
		}, 250);
		return () => { alive = false; window.clearTimeout(timer); };
	}, [open, query, selected.name]);

	const save = async (): Promise<void> => {
		const nextQty = Number(qty.replace(',', '.'));
		if (query.trim() !== selected.name) { setError('Выберите товар из результатов поиска.'); return; }
		if (!Number.isFinite(nextQty) || nextQty <= 0) { setError('Укажите количество больше нуля.'); return; }
		if (nextQty < minimum) { setError(`Нельзя уменьшить ниже уже распределённого количества: ${minimum}.`); return; }
		setBusy(true); setError('');
		try {
			await updateSupplyRequestLine({
				requestName: order.name,
				requestKey: order.requestKey,
				...(item.rowName ? { rowName: item.rowName } : {}),
				productId: item.productId,
				nextProductId: selected.id,
				nextItemName: selected.name,
				nextQty,
			});
			await onSaved();
			setOpen(false);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Не удалось изменить позицию.');
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<button className="supply-line-edit" type="button" onClick={() => setOpen(true)}>изменить</button>
			{open && <div className="supply-proto-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
				<section className="supply-proto-modal supply-line-edit-modal" role="dialog" aria-modal="true" aria-label="Изменить позицию заявки" onMouseDown={(event) => event.stopPropagation()}>
					<header><div><h2>Изменить позицию</h2><p>{order.name} · источник: сделка #{order.dealId}</p></div><button type="button" disabled={busy} onClick={() => setOpen(false)}>×</button></header>
					<p className="muted small">Изменение сохранится только в заявке снабжению. Состав сделки менеджер меняет отдельно.</p>
					<label><span>Товар</span><input value={query} disabled={busy} onChange={(event) => { setQuery(event.target.value); setError(''); }} /></label>
					{results.length > 0 && <div className="supply-line-search-results">{results.map((row) => <button key={row.id} type="button" onClick={() => { setSelected(row); setQuery(row.name); setResults([]); }}>{row.name}<small>#{row.id}</small></button>)}</div>}
					<label><span>Количество в заявке</span><input type="number" min={minimum || 0.001} step="any" value={qty} disabled={busy} onChange={(event) => { setQty(event.target.value); setError(''); }} /><small>Уже распределено: {minimum}</small></label>
					{selected.id !== item.productId && minimum > 0 && <p className="supply-order-review-error">Товар уже попал в закупку или перемещение и целиком заменить его нельзя. Необработанный остаток оформите отдельной строкой заявки.</p>}
					{error && <p className="supply-order-review-error">{error}</p>}
					<footer><button type="button" disabled={busy} onClick={() => setOpen(false)}>Отмена</button><button className="primary" type="button" disabled={busy || !selected.id || query.trim() !== selected.name || (selected.id !== item.productId && minimum > 0)} onClick={() => void save()}>{busy ? 'Сохраняю...' : 'Сохранить'}</button></footer>
				</section>
			</div>}
		</>
	);
}
