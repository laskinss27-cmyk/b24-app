import { useCallback, useEffect, useState } from 'react';
import { diagnoseAdminDealDocuments, searchAdminDealDocuments, type AdminDealDocumentDiagnostic, type AdminDealDocumentSummary } from './admin-deal-documents-api.js';
import { DealDocumentDiagnosticDetails } from './DealDocumentDiagnosticDetails.js';

export function DealDocumentDiagnostics(): JSX.Element {
	const [query, setQuery] = useState('');
	const [deals, setDeals] = useState<AdminDealDocumentSummary[]>([]);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [diagnostic, setDiagnostic] = useState<AdminDealDocumentDiagnostic | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	const search = useCallback(async (value: string): Promise<void> => {
		setLoading(true);
		setError('');
		setSelectedId(null);
		setDiagnostic(null);
		try {
			setDeals(await searchAdminDealDocuments(value));
		} catch (searchError) {
			setError(searchError instanceof Error ? searchError.message : String(searchError));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { void search(''); }, [search]);

	async function selectDeal(dealId: number): Promise<void> {
		setSelectedId(dealId);
		setDiagnostic(null);
		setLoading(true);
		setError('');
		try {
			setDiagnostic(await diagnoseAdminDealDocuments(dealId));
		} catch (diagnoseError) {
			setError(diagnoseError instanceof Error ? diagnoseError.message : String(diagnoseError));
		} finally {
			setLoading(false);
		}
	}

	async function refreshSelectedDeal(): Promise<void> {
		if (selectedId === null) return;
		setDiagnostic(await diagnoseAdminDealDocuments(selectedId));
	}

	return (
		<div className="deal-document-diagnostics">
			<form className="admin-search" onSubmit={(event) => { event.preventDefault(); void search(query); }}>
				<label>Сделка или документ ядра
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: 37868, MAT-MR-…, PUR-ORD-… или MAT-DN-…" />
				</label>
				<button type="submit" className="btn-primary" disabled={loading}>Найти</button>
			</form>

			{error && <p className="admin-state error">⛔ {error}</p>}
			{loading && <p className="admin-state">Читаю документы…</p>}
			{!loading && !error && deals.length === 0 && <p className="admin-state">Документы не найдены.</p>}

			<div className="admin-document-layout">
				<aside className="admin-document-list">
					{deals.map((deal) => (
						<button type="button" key={deal.dealId} className={selectedId === deal.dealId ? 'active' : ''} onClick={() => void selectDeal(deal.dealId)}>
							<span><strong>Сделка #{deal.dealId}</strong>{deal.draftCount > 0 && <em>{deal.draftCount} черн.</em>}</span>
							<small>Планы: {deal.planCount} · реализации/возвраты: {deal.realizationCount} · снабжение/склад: {deal.relatedCount}</small>
							<small>{deal.lastDocument || 'Связанных документов пока нет'}</small>
						</button>
					))}
				</aside>
				<main>{diagnostic ? <DealDocumentDiagnosticDetails diagnostic={diagnostic} onDiagnosticChanged={refreshSelectedDeal} /> : !loading && <p className="admin-empty-selection">Выберите сделку слева, чтобы увидеть всю цепочку документов.</p>}</main>
			</div>
		</div>
	);
}
