import { useState } from 'react';
import type { BaseRow } from './b24.js';

export function CatalogPriceEditorModal({ row, onSave, onClose }: {
	row: BaseRow;
	onSave: (retail: number, purchase: number) => Promise<void>;
	onClose: () => void;
}): JSX.Element {
	const [retailText, setRetailText] = useState(String(row.retail ?? 0));
	const [purchaseText, setPurchaseText] = useState(String(row.purchase ?? 0));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const save = async (): Promise<void> => {
		const retail = retailText.trim() === '' ? NaN : Number(retailText.replace(',', '.'));
		const purchase = purchaseText.trim() === '' ? NaN : Number(purchaseText.replace(',', '.'));
		if (!Number.isFinite(retail) || retail < 0 || !Number.isFinite(purchase) || purchase < 0) {
			setError('Укажи обе цены: 0 или больше.');
			return;
		}
		setBusy(true);
		setError('');
		try {
			await onSave(retail, purchase);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="catalog-price-overlay" onClick={onClose}>
			<div className="catalog-price-modal" onClick={(event) => event.stopPropagation()}>
				<div className="catalog-price-head">
					<div><span>Цены товара</span><h2>{row.name}</h2><small>#{row.id}</small></div>
					<button type="button" className="icon-close" aria-label="Закрыть" onClick={onClose}>×</button>
				</div>
				<div className="catalog-price-fields">
					<label>Розничная, ₽<input autoFocus inputMode="decimal" value={retailText} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setRetailText(event.target.value)} /></label>
					<label>Закупочная, ₽<input inputMode="decimal" value={purchaseText} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setPurchaseText(event.target.value)} /></label>
				</div>
				{error && <div className="new-product-error">{error}</div>}
				<div className="new-product-actions">
					<button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>Отмена</button>
					<button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
				</div>
			</div>
		</div>
	);
}
