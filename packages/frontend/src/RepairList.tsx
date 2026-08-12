import { useEffect, useMemo, useState } from 'react';
import type { Repair, RepairStatus } from './b24.js';
import { repairDate as ruDate, repairDisplayNumber as repairNo, repairMoney as money, repairPointLabel } from './repair-display.js';
import { CLIENT_REPAIR_STATUS_FLOW as STATUS_FLOW, REPAIR_STATUS_LABELS as STATUS_LABEL } from './repair-status.js';

export function RepairList({ repairs, loading, err, onAdd, onPresale, onOpen, onPrintSelected, onReload }: {
	repairs: Repair[]; loading: boolean; err: string | null;
	onAdd: () => void; onPresale: () => void; onOpen: (r: Repair) => void; onPrintSelected: (repairs: Repair[]) => void; onReload: () => void;
}): JSX.Element {
	const [q, setQ] = useState('');
	const [st, setSt] = useState<RepairStatus | 'all'>('all');
	const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
	const view = useMemo(() => {
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		return repairs.filter((r) => {
			if (st !== 'all' && r.status !== st) return false;
			if (!words.length) return true;
			const status = STATUS_LABEL[r.status] ?? r.status;
			const history = (r.history ?? []).map((h) => `${h.byName ?? h.byId ?? ''} ${h.note ?? ''} ${STATUS_LABEL[h.status] ?? h.status}`).join(' ');
			const files = (r.files ?? []).map((file) => file.name).join(' ');
			const refusal = r.clientRefusal ? `клиент отказался отказ ${r.clientRefusal.reason} ${r.clientRefusal.byName}` : '';
			const hay = `${repairNo(r)} ${r.id} ${r.client.name} ${r.client.phone} ${repairPointLabel(r)} ${r.device} ${r.model} ${r.serial} ${r.defect} ${r.comment} ${r.internalComment ?? ''} ${r.createdByName} ${r.createdById} ${r.dealId ?? ''} ${r.taskId ?? ''} ${status} ${refusal} ${files} ${history}`.toLowerCase();
			return words.every((w) => hay.includes(w));
		});
	}, [repairs, q, st]);
	const active = view.filter((r) => r.status !== 'issued').length;
	const selectedRepairs = repairs.filter((repair) => selectedIds.has(repair.id));
	const allVisibleSelected = view.length > 0 && view.every((repair) => selectedIds.has(repair.id));

	useEffect(() => {
		const existing = new Set(repairs.map((repair) => repair.id));
		setSelectedIds((current) => new Set([...current].filter((id) => existing.has(id))));
	}, [repairs]);

	const toggleRepair = (id: number): void => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleVisible = (): void => {
		setSelectedIds((current) => {
			const next = new Set(current);
			for (const repair of view) {
				if (allVisibleSelected) next.delete(repair.id);
				else next.add(repair.id);
			}
			return next;
		});
	};

	return (
		<>
			<div className="base-toolbar">
				<button className="btn-primary" onClick={onAdd}>➕ Принять в ремонт</button>
				<button className="btn-secondary" onClick={onPresale}>🛠 Предпродажный ремонт</button>
				<button className="btn-secondary" disabled={selectedRepairs.length === 0} onClick={() => onPrintSelected(selectedRepairs)}>Сопроводительное письмо{selectedRepairs.length ? ` (${selectedRepairs.length})` : ''}</button>
				<label className="tb-field">Статус
					<select value={st} onChange={(e) => setSt(e.target.value as RepairStatus | 'all')}>
						<option value="all">Все статусы</option>
						{STATUS_FLOW.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
					</select>
				</label>
				<label className="tb-field tb-search">Поиск (№ · клиент · серийник · модель · комментарий)
					<input type="search" value={q} placeholder="1042, иванов, M5702…" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
				</label>
				<div className="tb-spacer" />
				<button className="btn-secondary" onClick={onReload} disabled={loading} title="Обновить список">{loading ? 'Гружу…' : '↻ Обновить'}</button>
			</div>

			{err && <p className="error">⛔ {err}</p>}
			{loading && repairs.length === 0 && <p className="muted">Загружаю ремонты…</p>}

			{!loading && view.length === 0 ? (
				<p className="stub-calm">{(q || st !== 'all') ? 'Ничего не найдено.' : 'Ремонтов пока нет. Нажми «Принять в ремонт».'}</p>
			) : (
				<div className="table-wrap">
					<table className="products-table report-table">
						<thead>
							<tr><th className="repair-select-cell"><input type="checkbox" checked={allVisibleSelected} aria-label="Выбрать все показанные ремонты" onChange={toggleVisible} /></th><th>№</th><th>Клиент</th><th>ТТ приема</th><th>Оборудование</th><th>Серийный №</th><th>Вид</th><th>Наша цена</th><th>Неисправность</th><th>Комментарий</th><th>Статус</th><th>Принят</th></tr>
						</thead>
						<tbody>
							{view.map((r) => (
								<tr key={r.id} className={`repair-row${r.status === 'issued' ? ' done' : ''}${selectedIds.has(r.id) ? ' selected' : ''}`} onClick={() => onOpen(r)}>
									<td className="repair-select-cell" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedIds.has(r.id)} aria-label={`Выбрать ремонт № ${repairNo(r)}`} onChange={() => toggleRepair(r.id)} /></td>
									<td><b>#{repairNo(r)}</b></td>
									<td>{r.kind === 'presale' ? <span className="pay-badge presale">🛠 предпродажа</span> : (<>{r.client.name || <span className="muted">—</span>}{r.client.phone && <div className="muted small">{r.client.phone}</div>}</>)}</td>
									<td className="nowrap">{repairPointLabel(r) || <span className="muted">—</span>}</td>
									<td>{[r.device, r.model].filter(Boolean).join(' ') || <span className="muted">—</span>}</td>
									<td className="nowrap">{r.serial || <span className="muted">—</span>}</td>
									<td>{r.kind === 'presale' ? <span className="muted">—</span> : <span className={`pay-badge ${r.payType}`}>{r.payType === 'paid' ? 'платный' : 'гарантия'}</span>}</td>
									<td className="nowrap">{r.payType === 'paid' && r.ourPrice != null ? <b>{money(r.ourPrice)}</b> : <span className="muted">—</span>}</td>
									<td className="repair-comment">{r.defect ? <span title={r.defect}>{r.defect}</span> : <span className="muted">—</span>}</td>
									<td className="repair-comment">{r.internalComment ? <span title={r.internalComment}>{r.internalComment}</span> : <span className="muted">—</span>}</td>
									<td>{r.status === 'issued'
										? <span className="status-done">{r.clientRefusal ? 'возвращён клиенту' : 'завершён'}</span>
										: <>{r.clientRefusal && <span className="repair-refusal-badge">отказ клиента</span>}<span className={`repair-st st-${r.status}`}>{STATUS_LABEL[r.status]}</span></>}</td>
									<td className="muted nowrap">{ruDate(r.createdAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<div className="base-foot">
				<span>Всего: {view.length}</span>
				<span>В работе: {active}</span>
			</div>
		</>
	);
}
