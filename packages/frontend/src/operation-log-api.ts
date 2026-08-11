import { bx24Auth } from './bitrix-auth.js';

export type OperationLogOutcome = 'success' | 'failure';

export interface OperationLogEvent {
	id: string;
	occurredAt: string;
	level: 'info' | 'warning' | 'error';
	area: string;
	operation: string;
	outcome: OperationLogOutcome;
	summary: string;
	actor?: { id: string; name: string };
	deal?: { id: number; title?: string };
	documents?: string[];
	details?: Record<string, string | number | boolean>;
}

export async function fetchOperationLog(outcome?: OperationLogOutcome): Promise<OperationLogEvent[]> {
	const response = await fetch('/api/operation-log/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), area: 'realizations', limit: 200, ...(outcome ? { outcome } : {}) }),
	});
	const json = await response.json() as { ok?: boolean; error?: string; events?: OperationLogEvent[] };
	if (!response.ok || !json.ok) throw new Error(json.error ?? 'не удалось загрузить журнал операций');
	return json.events ?? [];
}
