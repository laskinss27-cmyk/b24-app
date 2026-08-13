import { useState } from 'react';
import { restoreAdminDealDocumentLink, type AdminDealDocumentDiagnostic } from './admin-deal-documents-api.js';

type Structure = AdminDealDocumentDiagnostic['structure'];
type Link = Structure['links'][number];

const STATUS_LABELS: Record<Link['status'], string> = {
	linked: 'связано',
	wrong_deal: 'вне этой сделки',
	missing: 'не найдено',
	unreadable: 'не проверено',
};

function canRestore(link: Link): boolean {
	return link.status === 'wrong_deal' && link.targetDealId === null && link.targetDocstatus === 0;
}

export function DealDocumentStructureReport({ dealId, structure, onRestored }: { dealId: number; structure: Structure; onRestored: () => Promise<void> }): JSX.Element {
	const problemLinks = structure.links.filter((link) => link.status !== 'linked');
	const [selected, setSelected] = useState<Link | null>(null);
	const [comment, setComment] = useState('');
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState('');

	async function restore(): Promise<void> {
		if (!selected || comment.trim().length < 3) return;
		setSaving(true);
		setMessage('');
		try {
			await restoreAdminDealDocumentLink({ dealId, targetType: selected.targetType, targetName: selected.targetName, comment });
			setSelected(null);
			setComment('');
			setMessage('Связь восстановлена. Диагностика обновлена.');
			await onRestored();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}
	return (
		<section className="admin-panel admin-structure-report">
			<header>
				<div><h3>Структура документов</h3><p>Проверяются только явные ссылки между документами. Никакие данные не изменяются.</p></div>
				<span className={`admin-structure-status ${structure.status}`}>{structure.brokenLinkCount ? `проблем: ${structure.brokenLinkCount}` : 'связи целы'}</span>
			</header>

			{structure.checkedLinkCount === 0
				? <p>В этой цепочке нет явных ссылок, требующих отдельной проверки.</p>
				: problemLinks.length === 0
					? <p className="admin-clean-state">Проверено связей: {structure.checkedLinkCount}. Потерянных документов не найдено.</p>
					: <div className="admin-structure-links">{problemLinks.map((link, index) => (
						<article key={`${link.fromName}-${link.relation}-${link.targetName}-${index}`} className={link.status}>
							<div><strong>{link.fromType} · {link.fromName}</strong><span>{link.relation} → {link.targetType} · {link.targetName}</span></div>
							<em>{STATUS_LABELS[link.status]}</em>
							<p>{link.details}</p>
							{canRestore(link) && <button type="button" className="btn-secondary admin-restore-link-button" onClick={() => { setSelected(link); setComment(''); setMessage(''); }}>Восстановить связь</button>}
						</article>))}</div>}

			{selected && <div className="admin-restore-link-confirmation">
				<strong>Привязать {selected.targetType} {selected.targetName} к сделке #{dealId}?</strong>
				<p>Изменится только пустое поле связи у черновика. Статус документа, строки и складские остатки не меняются.</p>
				<label>Обязательный комментарий<textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={500} placeholder="Почему связь нужно восстановить" /></label>
				<div><button type="button" className="btn-primary" disabled={saving || comment.trim().length < 3} onClick={() => void restore()}>{saving ? 'Проверяю…' : 'Подтвердить восстановление'}</button><button type="button" className="btn-secondary" disabled={saving} onClick={() => setSelected(null)}>Отмена</button></div>
			</div>}
			{message && <p className="admin-restore-link-message">{message}</p>}

			{structure.links.length > 0 && <details className="admin-structure-all-links"><summary>Все проверенные связи ({structure.checkedLinkCount})</summary>
				<ul>{structure.links.map((link, index) => <li key={`${link.fromName}-${link.targetName}-${index}`}><b>{link.fromName}</b> — {link.relation} → <b>{link.targetName}</b> <span className={link.status}>{STATUS_LABELS[link.status]}</span></li>)}</ul>
			</details>}
		</section>
	);
}
