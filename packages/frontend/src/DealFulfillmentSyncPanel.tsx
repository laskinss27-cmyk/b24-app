import { useState } from 'react';
import { synchronizeAdminDealFulfillment, type AdminDealDocumentDiagnostic } from './admin-deal-documents-api.js';

const BLOCKING_ISSUES = new Set(['deal_read_error', 'missing_plan', 'multiple_plans']);

function canSynchronize(diagnostic: AdminDealDocumentDiagnostic): diagnostic is AdminDealDocumentDiagnostic & {
	deal: AdminDealDocumentDiagnostic['deal'] & { fulfillmentField: 'ДА' | 'НЕТ' };
} {
	return diagnostic.deal.found === true
		&& (diagnostic.deal.fulfillmentField === 'ДА' || diagnostic.deal.fulfillmentField === 'НЕТ')
		&& diagnostic.deal.fulfillmentField !== diagnostic.calculatedFulfillment
		&& !diagnostic.issues.some((issue) => BLOCKING_ISSUES.has(issue.code));
}

export function DealFulfillmentSyncPanel({ diagnostic, onSynchronized }: {
	diagnostic: AdminDealDocumentDiagnostic;
	onSynchronized: () => Promise<void>;
}): JSX.Element | null {
	const [confirming, setConfirming] = useState(false);
	const [comment, setComment] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	if (!canSynchronize(diagnostic)) return null;

	async function synchronize(): Promise<void> {
		if (!canSynchronize(diagnostic) || comment.trim().length < 3) return;
		setSaving(true);
		setError('');
		try {
			await synchronizeAdminDealFulfillment({
				dealId: diagnostic.deal.id,
				expectedCurrent: diagnostic.deal.fulfillmentField,
				expectedValue: diagnostic.calculatedFulfillment,
				comment,
			});
			await onSynchronized();
		} catch (syncError) {
			setError(syncError instanceof Error ? syncError.message : String(syncError));
		} finally {
			setSaving(false);
		}
	}

	return (
		<section className="admin-panel admin-fulfillment-sync">
			<h3>Синхронизация полной отгрузки</h3>
			<p>Битрикс24 хранит «{diagnostic.deal.fulfillmentField}», а документы ядра дают «{diagnostic.calculatedFulfillment}».</p>
			{!confirming
				? <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>Синхронизировать техническое поле</button>
				: <div className="admin-fulfillment-confirmation">
					<strong>Изменить только поле полной отгрузки: «{diagnostic.deal.fulfillmentField}» → «{diagnostic.calculatedFulfillment}»?</strong>
					<p>Приложение не меняет этап, состав, суммы, реализации и остатки. Роботы Битрикс24 могут отреагировать на новое значение поля так же, как после обычной реализации.</p>
					<label>Обязательный комментарий<textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={500} placeholder="Почему выполняется синхронизация" /></label>
					<div><button type="button" className="btn-primary" disabled={saving || comment.trim().length < 3} onClick={() => void synchronize()}>{saving ? 'Перепроверяю…' : 'Подтвердить'}</button><button type="button" className="btn-secondary" disabled={saving} onClick={() => { setConfirming(false); setComment(''); setError(''); }}>Отмена</button></div>
				</div>}
			{error && <p className="admin-state error">⛔ {error}</p>}
		</section>
	);
}
