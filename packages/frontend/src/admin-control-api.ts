import { bx24Auth } from './bitrix-auth.js';

export interface AdminControlFinding {
	id: string;
	area: 'deal' | 'repair';
	entityId: number;
	entityLabel: string;
	code: string;
	severity: 'info' | 'warning' | 'error';
	title: string;
	details: string;
}

export interface AdminControlReport {
	generatedAt: string;
	dateFrom: string;
	dateTo: string;
	checkedDeals: number;
	checkedRepairs: number;
	findings: AdminControlFinding[];
}

export async function checkAdminControl(dateFrom: string, dateTo: string): Promise<AdminControlReport> {
	const response = await fetch('/api/admin/control/check', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dateFrom, dateTo }),
	});
	const json = await response.json() as { ok?: boolean; error?: string; report?: AdminControlReport };
	if (!response.ok || !json.ok) throw new Error(json.error ?? 'Не удалось выполнить контрольную проверку.');
	if (!json.report) throw new Error('Сервер не вернул результат контрольной проверки.');
	return json.report;
}
