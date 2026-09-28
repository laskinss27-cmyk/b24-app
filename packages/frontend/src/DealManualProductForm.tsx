import { useState } from 'react';
import { bx24Auth } from './bitrix-auth.js';

export function DealManualProductForm({ dealId, variantId, onCancel, onAdded }: {
	dealId: number; variantId?: string; onCancel: () => void; onAdded: () => Promise<void>;
}): JSX.Element {
	const [name, setName] = useState('');
	const [unit, setUnit] = useState('шт.');
	const [quantity, setQuantity] = useState('1');
	const [price, setPrice] = useState('');
	const [discount, setDiscount] = useState('0');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	return <form className="deal-manual-form" onSubmit={async (event) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true); setError('');
		try {
			const response = await fetch('/api/deal/add-manual', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...bx24Auth(), dealId, variantId, name: name.trim(), unit: unit.trim(), quantity: Number(quantity), price: Number(price), discountPercent: Number(discount) }),
			});
			const result = await response.json() as { ok: boolean; error?: string };
			if (!result.ok) throw new Error(result.error || 'Не удалось добавить строку');
			await onAdded();
		} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	}}>
		<h2>Добавить товар вручную</h2>
		<p>Строка сохранится в сделке и попадёт в КП.</p>
		<fieldset disabled={busy}>
			<label className="manual-wide">Название<input autoFocus required maxLength={500} value={name} onChange={(event) => setName(event.target.value)} /></label>
			<label>Количество<input required type="number" min="0.000001" step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
			<label>Единица<input required maxLength={20} value={unit} onChange={(event) => setUnit(event.target.value)} /></label>
			<label>Цена, ₽<input required type="number" min="0" step="any" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
			<label>Скидка, %<input required type="number" min="0" max="100" step="any" value={discount} onChange={(event) => setDiscount(event.target.value)} /></label>
		</fieldset>
		{error && <p role="alert" className="error">{error}</p>}
		<footer><button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Отмена</button><button type="submit" className="btn-primary" disabled={busy || !name.trim() || !unit.trim()}>{busy ? 'Добавляю…' : 'Добавить'}</button></footer>
	</form>;
}
