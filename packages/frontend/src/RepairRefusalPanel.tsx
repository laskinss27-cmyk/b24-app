import { useState } from 'react';
import type { Repair } from './repair-api.js';
import { repairDateTime } from './repair-display.js';

export function RepairRefusalPanel({
	repair,
	disabled,
	onRefuse,
}: {
	repair: Repair;
	disabled: boolean;
	onRefuse: (reason: string) => Promise<{ repair: Repair; warnings: string[] }>;
}): JSX.Element {
	const refusal = repair.clientRefusal;
	const [editing, setEditing] = useState(false);
	const [reason, setReason] = useState(refusal?.reason ?? '');
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const pending = Boolean(refusal && (!refusal.dealCancelled || !refusal.taskReframed));

	async function submit(): Promise<void> {
		const value = reason.trim();
		if (value.length < 3) { setMessage('Укажи причину отказа.'); return; }
		if (!refusal && !window.confirm('Оформить отказ клиента? Сделка ремонта будет закрыта как проигранная.')) return;
		setBusy(true); setMessage(null);
		try {
			const result = await onRefuse(value);
			setEditing(false);
			setMessage(result.warnings.length ? `⚠ ${result.warnings.join(' · ')}` : '✓ Отказ оформлен. Оборудование нужно вернуть клиенту обычной цепочкой статусов.');
		} catch (error) {
			setMessage(`⛔ ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setBusy(false);
		}
	}

	if (refusal) {
		return (
			<div className="rc-refusal">
				<strong>Клиент отказался от ремонта</strong>
				<span>{repairDateTime(refusal.at)} · {refusal.byName || `#${refusal.byId}`}</span>
				<span>Причина: {refusal.reason}</span>
				<span>{repair.status === 'issued' ? 'Оборудование возвращено клиенту.' : 'Оборудование ещё нужно довести до точки выдачи и выдать клиенту.'}</span>
				{pending && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void submit()}>{busy ? 'Повторяю…' : 'Повторить отмену сделки / обновление задачи'}</button>}
				{message && <span className={message.startsWith('⛔') || message.startsWith('⚠') ? 'error' : 'muted small'}>{message}</span>}
			</div>
		);
	}

	return (
		<div className="rc-refusal-action">
			{!editing ? (
				<button type="button" className="btn-danger" disabled={disabled} onClick={() => setEditing(true)}>Клиент отказался от ремонта</button>
			) : (
				<div className="rc-refusal-editor">
					<label>Причина отказа
						<textarea rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
					</label>
					<div><button type="button" className="btn-danger" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>{busy ? 'Оформляю…' : 'Подтвердить отказ'}</button> <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setEditing(false); setMessage(null); }}>Отмена</button></div>
				</div>
			)}
			{message && <span className="error">{message}</span>}
		</div>
	);
}
