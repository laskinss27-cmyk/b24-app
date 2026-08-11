export type OperationLogLevel = 'info' | 'warning' | 'error';
export type OperationLogOutcome = 'success' | 'failure';

export interface OperationLogActor {
	id: string;
	name: string;
}

export interface OperationLogDeal {
	id: number;
	title?: string;
}

export type OperationLogDetailValue = string | number | boolean;

export interface OperationLogEvent {
	id: string;
	occurredAt: string;
	level: OperationLogLevel;
	area: string;
	operation: string;
	outcome: OperationLogOutcome;
	summary: string;
	actor?: OperationLogActor;
	deal?: OperationLogDeal;
	documents?: string[];
	details?: Record<string, OperationLogDetailValue>;
}

export interface OperationLogListFilter {
	area?: string;
	outcome?: OperationLogOutcome;
	limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasValidOptionalFields(value: Record<string, unknown>): boolean {
	const actor = value['actor'];
	if (actor !== undefined && (!isRecord(actor) || typeof actor['id'] !== 'string' || typeof actor['name'] !== 'string')) return false;
	const deal = value['deal'];
	if (deal !== undefined && (!isRecord(deal) || !Number.isInteger(deal['id']))) return false;
	const documents = value['documents'];
	if (documents !== undefined && (!Array.isArray(documents) || documents.some((item) => typeof item !== 'string'))) return false;
	const details = value['details'];
	if (details !== undefined && (!isRecord(details) || Object.values(details).some((item) => !['string', 'number', 'boolean'].includes(typeof item)))) return false;
	return true;
}

export function isOperationLogEvent(value: unknown): value is OperationLogEvent {
	if (!isRecord(value)) return false;
	return typeof value['id'] === 'string'
		&& typeof value['occurredAt'] === 'string'
		&& (value['level'] === 'info' || value['level'] === 'warning' || value['level'] === 'error')
		&& typeof value['area'] === 'string'
		&& typeof value['operation'] === 'string'
		&& (value['outcome'] === 'success' || value['outcome'] === 'failure')
		&& typeof value['summary'] === 'string'
		&& hasValidOptionalFields(value);
}
