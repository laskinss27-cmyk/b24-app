import { useState } from 'react';
import { DealDocumentDiagnostics } from './DealDocumentDiagnostics.js';
import { OperationLog } from './OperationLog.js';
import { RepairDiagnostics } from './RepairDiagnostics.js';
import { AdminControlOverview } from './AdminControlOverview.js';
import type { AdminControlFinding } from './admin-control-api.js';

type AdminSection = 'control' | 'repairs' | 'dealDocuments' | 'operationLog';

export function AdminConsole({ onBack }: { onBack: () => void }): JSX.Element {
	const [section, setSection] = useState<AdminSection>('control');
	const [selectedRepairId, setSelectedRepairId] = useState<number | null>(null);
	const [selectedDealId, setSelectedDealId] = useState<number | null>(null);

	function openFinding(finding: AdminControlFinding): void {
		if (finding.area === 'deal') {
			setSelectedDealId(finding.entityId);
			setSection('dealDocuments');
		} else {
			setSelectedRepairId(finding.entityId);
			setSection('repairs');
		}
	}
	return (
		<div className="admin-console">
			<header className="admin-console-header">
				<div>
					<button type="button" className="btn-secondary" onClick={onBack}>← База товаров</button>
					<h1>Админка приложения</h1>
					<p>Диагностика связей между Битрикс24 и ядром склада.</p>
				</div>
				<strong className="admin-readonly-badge">Действия с подтверждением</strong>
			</header>
			<nav className="admin-console-tabs">
				<button type="button" className={section === 'control' ? 'active' : ''} onClick={() => setSection('control')}>Контроль проблем</button>
				<button type="button" className={section === 'repairs' ? 'active' : ''} onClick={() => setSection('repairs')}>Диагностика ремонтов</button>
				<button type="button" className={section === 'dealDocuments' ? 'active' : ''} onClick={() => setSection('dealDocuments')}>Документы сделок</button>
				<button type="button" className={section === 'operationLog' ? 'active' : ''} onClick={() => setSection('operationLog')}>Журнал операций</button>
			</nav>
			{section === 'control'
				? <AdminControlOverview onOpenFinding={openFinding} />
				: section === 'repairs'
				? <RepairDiagnostics initialRepairId={selectedRepairId} />
				: section === 'dealDocuments'
					? <DealDocumentDiagnostics initialDealId={selectedDealId} />
					: <OperationLog onBack={() => setSection('repairs')} backLabel="← Диагностика ремонтов" />}
		</div>
	);
}
