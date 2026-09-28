import { useEffect, useState } from 'react';
import { getContext } from './b24-context.js';
import { fetchStockAndPurchasing } from './deal-stock.js';
import { updateCatalogPurchasePrice } from './product-catalog.js';

export function ReceiptPurchasePrices({ items, onBack, onClose }: {
	items: Array<{ productId: number; itemName: string }>;
	onBack: () => void;
	onClose: () => void;
}): JSX.Element {
	const [prices, setPrices] = useState<Record<number, string>>({});
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState<number | null>(null);
	const [saved, setSaved] = useState<Record<number, boolean>>({});
	const [error, setError] = useState('');
	const products = [...new Map(items.map((item) => [item.productId, item])).values()];
	useEffect(() => {
		let active = true;
		const load = async (): Promise<void> => {
			try {
				const current = getContext().__mock ? {} : await fetchStockAndPurchasing(items.map((item) => item.productId));
				if (active) setPrices(Object.fromEntries(items.map((item) => [item.productId, current[item.productId]?.purchasingPrice?.toString() ?? ''])));
			} catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
			finally { if (active) setLoading(false); }
		};
		void load();
		return () => { active = false; };
	}, [items]);
	const save = async (id: number): Promise<void> => {
		const value = Number((prices[id] ?? '').replace(',', '.'));
		if (!Number.isFinite(value) || value <= .01) { setError('Укажите закупочную цену больше 0,01 ₽.'); return; }
		setSaving(id); setError('');
		try {
			const actual = getContext().__mock ? value : await updateCatalogPurchasePrice(id, value);
			setPrices((current) => ({ ...current, [id]: String(actual) }));
			setSaved((current) => ({ ...current, [id]: true }));
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSaving(null); }
	};
	return <section aria-label="Закупочные цены для сделок">
		<h3>Закупочные цены для сделок</h3>
		<p>Эти цены используются в списке товаров сделки и в каталоге. Историческая цена прихода и складские движения останутся прежними.</p>
		{loading && <p role="status">Загружаю текущие цены…</p>}
		{products.map((item) => <div key={item.productId} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 8, padding: '10px 0', borderBottom: '1px solid var(--app-border)' }}>
			<label style={{ display: 'grid', gap: 6, flex: '1 1 260px' }}>{item.itemName} · #{item.productId}<span>Текущая закупочная цена, ₽</span><input aria-label={`Закупочная цена #${item.productId}`} inputMode="decimal" value={prices[item.productId] ?? ''} disabled={loading || saving !== null} onChange={(event) => { setPrices((current) => ({ ...current, [item.productId]: event.target.value })); setSaved((current) => ({ ...current, [item.productId]: false })); }} style={{ padding: 8, maxWidth: 180 }} /></label>
			<button type="button" className="btn-primary" disabled={loading || saving !== null} onClick={() => void save(item.productId)}>{saving === item.productId ? 'Сохраняю…' : 'Сохранить цену'}</button>
			{saved[item.productId] && <span role="status">Сохранено. Обновите список товаров сделки.</span>}
		</div>)}
		{error && <p role="alert" className="error">{error}</p>}
		<div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}><button type="button" className="btn-secondary" disabled={saving !== null} onClick={onBack}>Назад к документу</button><button type="button" className="btn-secondary" disabled={saving !== null} onClick={onClose}>Закрыть</button></div>
	</section>;
}
