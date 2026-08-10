import { useEffect, useState } from 'react';
import { createPresaleRepair, fetchRepairStoreStock, fetchStores, type Repair, type StoreInfo } from './b24.js';

/** Форма предпродажного ремонта: выбрать склад-источник → аппарат из его остатков → в ремонт.
 *  Без клиента/цен/сделки — двигаем существующий товар (productId) по складам. */
export function PresaleRepairForm({ mock, onCancel, onDone }: { mock: boolean; onCancel: () => void; onDone: (r: Repair) => Promise<void> }): JSX.Element {
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [sourceStore, setSourceStore] = useState('');
	const [items, setItems] = useState<Array<{ productId: number; name: string; qty: number }>>([]);
	const [loadingItems, setLoadingItems] = useState(false);
	const [picked, setPicked] = useState<{ productId: number; name: string } | null>(null);
	const [q, setQ] = useState('');
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => { if (!mock) fetchStores().then((s) => setStores(s.filter((x) => x.active))).catch(() => setStores([])); }, [mock]);
	async function loadItems(store: string): Promise<void> {
		setSourceStore(store); setPicked(null); setItems([]); setErr(null);
		if (!store || mock) return;
		setLoadingItems(true);
		try { setItems(await fetchRepairStoreStock(store)); } catch (e: unknown) { setErr(String(e instanceof Error ? e.message : e)); } finally { setLoadingItems(false); }
	}
	const filtered = items.filter((i) => { const t = q.trim().toLowerCase(); return !t || i.name.toLowerCase().includes(t) || String(i.productId).includes(t); });
	async function submit(): Promise<void> {
		if (!sourceStore) { setErr('Выбери склад-источник.'); return; }
		if (!picked) { setErr('Выбери аппарат из остатков склада.'); return; }
		setSaving(true); setErr(null);
		try {
			if (mock) {
				await onDone({ id: Math.floor(1000 + Math.random() * 9000), name: `[предпродажа] ${picked.name}`, kind: 'presale', status: 'pre_office', repairNo: 100, client: { contactId: null, name: '', phone: '' }, device: picked.name, model: '', serial: '', point: '', appearance: '', defect: '', payType: 'warranty', cost: null, ourPrice: null, dealId: null, comment: '', internalComment: '', photos: [], files: [], createdAt: new Date().toISOString(), createdById: 'dev', createdByName: 'dev (mock)', history: [], productId: picked.productId, sourceStore, repairStore: 'Измайловский 18Д', issueStore: null } as Repair);
				return;
			}
			const r = await createPresaleRepair(sourceStore, picked.productId, picked.name);
			await onDone(r);
		} catch (e: unknown) { setErr(String(e instanceof Error ? e.message : e)); } finally { setSaving(false); }
	}
	return (
		<div className="repair-form">
			<div className="base-backbar"><button className="btn-secondary" onClick={onCancel}>← К списку</button></div>
			<h2>🛠 Предпродажный ремонт</h2>
			<p className="muted small">Наш товар со склада уходит в ремонт. Выбери склад-источник и аппарат — дальше ведём по статусам. Без клиента, цен и сделки.</p>
			<div className="rf-grid">
				<label className="rf-field">Склад-источник
					<select value={sourceStore} onChange={(e) => void loadItems(e.target.value)}>
						<option value="">— выбери склад —</option>
						{stores.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
					</select>
				</label>
			</div>
			{sourceStore && (
				<label className="rf-field rf-wide">Аппарат (из остатков склада)
					<input type="search" value={q} placeholder="поиск по названию / id" onChange={(e) => setQ(e.target.value)} />
					{loadingItems ? <p className="muted small">Гружу остатки…</p> : (
						<div className="rf-suggest" style={{ position: 'static', maxHeight: 300 }}>
							{filtered.length === 0 ? <p className="muted small">Нет позиций с остатком на складе.</p> : filtered.slice(0, 100).map((i) => (
								<button key={i.productId} type="button" className={`rf-suggest-item${picked?.productId === i.productId ? ' active' : ''}`} onClick={() => setPicked({ productId: i.productId, name: i.name })}>
									{i.name} <span className="muted small">· #{i.productId} · остаток {i.qty}</span>
								</button>
							))}
						</div>
					)}
				</label>
			)}
			{picked && <p className="muted small">Выбран: <b>{picked.name}</b> (#{picked.productId}) → уйдёт в ремонт со склада «{sourceStore}».</p>}
			{err && <p className="error">⛔ {err}</p>}
			<div className="rf-actions">
				<button className="btn-primary" onClick={() => void submit()} disabled={saving || !picked}>{saving ? 'Создаю…' : 'В ремонт'}</button>
				<button className="btn-secondary" onClick={onCancel} disabled={saving}>Отмена</button>
			</div>
		</div>
	);
}
