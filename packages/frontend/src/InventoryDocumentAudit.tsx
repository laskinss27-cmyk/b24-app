import type { ErpInvDoc } from './inventory-api.js';

export function InventoryDocumentAudit({ document }: { document: ErpInvDoc }): JSX.Element | null {
	if (document.status !== 'submitted') return null;
	const known = Boolean(document.submittedById && document.submittedByName);
	const time = document.submittedAt && Number.isFinite(Date.parse(document.submittedAt))
		? new Date(document.submittedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : null;
	return <span style={{ display: 'block' }}>
		{known ? `Провёл: ${document.submittedByName} (ID ${document.submittedById})` : 'Автор проведения не записан'}
		{time ? ` · ${time} МСК` : ''}
	</span>;
}
