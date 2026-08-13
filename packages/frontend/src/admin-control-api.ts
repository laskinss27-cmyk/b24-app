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
	totalDeals: number;
	totalRepairs: number;
	checkedDeals: number;
	checkedRepairs: number;
	findings: AdminControlFinding[];
}

export type AdminControlProgress = AdminControlReport;

interface AdminControlBatch {
	scanId: string;
	generatedAt: string;
	dateFrom: string;
	dateTo: string;
	totalDeals: number;
	totalRepairs: number;
	checkedDeals: number;
	checkedRepairs: number;
	findings: AdminControlFinding[];
	nextCursor: { dealOffset: number; repairOffset: number } | null;
}

function responseError(status: number, text: string): Error {
	if (status === 504) return new Error('Пакет проверки не уложился в 60 секунд. Попробуйте ещё раз или выберите более короткий период.');
	const html = /^\s*</.test(text);
	return new Error(html ? `Сервер прервал проверку (HTTP ${status}).` : `Сервер вернул некорректный ответ (HTTP ${status}).`);
}

async function requestBatch(dateFrom: string, dateTo: string, dealOffset: number, repairOffset: number, scanId: string): Promise<AdminControlBatch> {
	const response = await fetch('/api/admin/control/check', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dateFrom, dateTo, dealOffset, repairOffset, ...(scanId ? { scanId } : {}) }),
	});
	const text = await response.text();
	let json: { ok?: boolean; error?: string; batch?: AdminControlBatch };
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		throw responseError(response.status, text);
	}
	if (!response.ok || !json.ok) throw new Error(json.error ?? 'Не удалось выполнить контрольную проверку.');
	if (!json.batch) throw new Error('Сервер не вернул пакет контрольной проверки.');
	return json.batch;
}

export async function checkAdminControl(
	dateFrom: string,
	dateTo: string,
	onProgress?: (progress: AdminControlProgress) => void,
): Promise<AdminControlReport> {
	let dealOffset = 0;
	let repairOffset = 0;
	let checkedDeals = 0;
	let checkedRepairs = 0;
	let totalDeals = 0;
	let totalRepairs = 0;
	let generatedAt = new Date().toISOString();
	let scanId = '';
	const findings = new Map<string, AdminControlFinding>();
	for (let batchNumber = 0; batchNumber < 10_000; batchNumber += 1) {
		const batch = await requestBatch(dateFrom, dateTo, dealOffset, repairOffset, scanId);
		scanId = batch.scanId;
		generatedAt = batch.generatedAt;
		totalDeals = batch.totalDeals;
		totalRepairs = batch.totalRepairs;
		checkedDeals += batch.checkedDeals;
		checkedRepairs += batch.checkedRepairs;
		for (const finding of batch.findings) findings.set(finding.id, finding);
		const progress = { generatedAt, dateFrom, dateTo, totalDeals, totalRepairs, checkedDeals, checkedRepairs, findings: [...findings.values()] };
		onProgress?.(progress);
		if (!batch.nextCursor) return progress;
		if (batch.nextCursor.dealOffset === dealOffset && batch.nextCursor.repairOffset === repairOffset) throw new Error('Пакетная проверка не продвигается. Запустите её заново.');
		dealOffset = batch.nextCursor.dealOffset;
		repairOffset = batch.nextCursor.repairOffset;
	}
	throw new Error('Контрольная проверка превысила допустимое количество пакетов.');
}
