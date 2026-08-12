import { useState } from 'react';
import { OperationLog } from './OperationLog.js';
import { RepairDiagnostics } from './RepairDiagnostics.js';

type AdminSection = 'repairs' | 'operationLog';

export function AdminConsole({ onBack }: { onBack: () => void }): JSX.Element {
	const [section, setSection] = useState<AdminSection>('repairs');
	return (
		<div className="admin-console">
			<header className="admin-console-header">
				<div>
					<button type="button" className="btn-secondary" onClick={onBack}>← База товаров</button>
					<h1>Админка приложения</h1>
					<p>Диагностика связей между Битрикс24 и ядром склада.</p>
				</div>
				<strong className="admin-readonly-badge">Только просмотр</strong>
			</header>
			<nav className="admin-console-tabs">
				<button type="button" className={section === 'repairs' ? 'active' : ''} onClick={() => setSection('repairs')}>Диагностика ремонтов</button>
				<button type="button" className={section === 'operationLog' ? 'active' : ''} onClick={() => setSection('operationLog')}>Журнал операций</button>
			</nav>
			{section === 'repairs' ? <RepairDiagnostics /> : <OperationLog onBack={() => setSection('repairs')} backLabel="← Диагностика ремонтов" />}
		</div>
	);
}
