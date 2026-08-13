import type { AdminDealDocumentDiagnostic } from './admin-deal-documents-api.js';

type Structure = AdminDealDocumentDiagnostic['structure'];
type Link = Structure['links'][number];

const STATUS_LABELS: Record<Link['status'], string> = {
	linked: 'связано',
	wrong_deal: 'вне этой сделки',
	missing: 'не найдено',
	unreadable: 'не проверено',
};

export function DealDocumentStructureReport({ structure }: { structure: Structure }): JSX.Element {
	const problemLinks = structure.links.filter((link) => link.status !== 'linked');
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
						</article>))}</div>}

			{structure.links.length > 0 && <details className="admin-structure-all-links"><summary>Все проверенные связи ({structure.checkedLinkCount})</summary>
				<ul>{structure.links.map((link, index) => <li key={`${link.fromName}-${link.targetName}-${index}`}><b>{link.fromName}</b> — {link.relation} → <b>{link.targetName}</b> <span className={link.status}>{STATUS_LABELS[link.status]}</span></li>)}</ul>
			</details>}
		</section>
	);
}
