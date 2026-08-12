import { useCallback, useEffect, useState } from 'react';
import { diagnoseAdminRepair, searchAdminRepairs, type AdminRepairDiagnostic, type AdminRepairSummary } from './admin-repair-diagnostics-api.js';
import { RepairDiagnosticDetails } from './RepairDiagnosticDetails.js';

const STATUS_LABELS: Record<string, string> = {
	received_tt: 'Принято на точке', received_office: 'В офисе', sent: 'В ремонте', sent_to_tt: 'Возвращается', ready_tt: 'Готово к выдаче', issued: 'Выдано',
	pre_office: 'В офисе', pre_sent: 'В ремонте', pre_back_office: 'Вернулось в офис', pre_to_point: 'На точку', pre_at_tt: 'На точке',
};

export function RepairDiagnostics(): JSX.Element {
	const [query, setQuery] = useState('');
	const [repairs, setRepairs] = useState<AdminRepairSummary[]>([]);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [diagnostic, setDiagnostic] = useState<AdminRepairDiagnostic | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	const search = useCallback(async (searchQuery: string): Promise<void> => {
		setLoading(true);
		setError('');
		setSelectedId(null);
		setDiagnostic(null);
		try {
			setRepairs(await searchAdminRepairs(searchQuery));
		} catch (searchError) {
			setError(searchError instanceof Error ? searchError.message : String(searchError));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { void search(''); }, [search]);

	async function selectRepair(repairId: number): Promise<void> {
		setSelectedId(repairId);
		setDiagnostic(null);
		setLoading(true);
		setError('');
		try {
			setDiagnostic(await diagnoseAdminRepair(repairId));
		} catch (diagnoseError) {
			setError(diagnoseError instanceof Error ? diagnoseError.message : String(diagnoseError));
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="repair-diagnostics">
			<form className="admin-search" onSubmit={(event) => { event.preventDefault(); void search(query); }}>
				<label>Ремонт, сделка, задача, документ, серийный номер или клиент
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: 37800, REPAIR-142 или Иванов" />
				</label>
				<button type="submit" className="btn-primary" disabled={loading}>Найти</button>
			</form>

			{error && <p className="admin-state error">⛔ {error}</p>}
			{loading && <p className="admin-state">Читаю данные…</p>}
			{!loading && !error && repairs.length === 0 && <p className="admin-state">Ничего не найдено.</p>}

			<div className="admin-repair-layout">
				<aside className="admin-repair-list">
					{repairs.map((repair) => (
						<button type="button" key={repair.id} className={selectedId === repair.id ? 'active' : ''} onClick={() => void selectRepair(repair.id)}>
							<span><strong>Ремонт #{repair.repairNo || repair.id}</strong>{repair.refused && <em>отказ</em>}</span>
							<span>{repair.clientName || 'Без клиента'}</span>
							<small>{[repair.device, repair.model, repair.serial].filter(Boolean).join(' · ') || 'Аппарат не указан'}</small>
							<small>{STATUS_LABELS[repair.status] ?? repair.status}{repair.dealId ? ` · сделка #${repair.dealId}` : ''}</small>
						</button>
					))}
				</aside>
				<main>{diagnostic ? <RepairDiagnosticDetails diagnostic={diagnostic} /> : !loading && <p className="admin-empty-selection">Выберите ремонт слева, чтобы сверить его структуру.</p>}</main>
			</div>
		</div>
	);
}
