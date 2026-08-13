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
	const [openedFromControl, setOpenedFromControl] = useState(false);

	function openFinding(finding: AdminControlFinding): void {
		setOpenedFromControl(true);
		if (finding.area === 'deal') {
			setSelectedDealId(finding.entityId);
			setSection('dealDocuments');
		} else {
			setSelectedRepairId(finding.entityId);
			setSection('repairs');
		}
	}

	function openSection(nextSection: AdminSection): void {
		setOpenedFromControl(false);
		setSection(nextSection);
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
				<button type="button" className={section === 'control' ? 'active' : ''} onClick={() => openSection('control')}>Контроль проблем</button>
				<button type="button" className={section === 'repairs' ? 'active' : ''} onClick={() => openSection('repairs')}>Диагностика ремонтов</button>
				<button type="button" className={section === 'dealDocuments' ? 'active' : ''} onClick={() => openSection('dealDocuments')}>Документы сделок</button>
				<button type="button" className={section === 'operationLog' ? 'active' : ''} onClick={() => openSection('operationLog')}>Журнал операций</button>
			</nav>
			<div hidden={section !== 'control'}><AdminControlOverview onOpenFinding={openFinding} /></div>
			{section !== 'control' && openedFromControl && <div className="admin-control-return"><button type="button" className="btn-secondary" onClick={() => { setOpenedFromControl(false); setSection('control'); }}>← К результатам проверки</button></div>}
			{section === 'repairs'
				? <RepairDiagnostics initialRepairId={selectedRepairId} />
				: section === 'dealDocuments'
					? <DealDocumentDiagnostics initialDealId={selectedDealId} />
					: section === 'operationLog'
						? <OperationLog onBack={() => openSection('repairs')} backLabel="← Диагностика ремонтов" />
						: null}
		</div>
	);
}
