import { randomUUID } from 'node:crypto';
import type { OperationLogActor, OperationLogDetailValue, OperationLogEvent, OperationLogLevel } from './model.js';
import type { OperationLogStore } from './store.js';

export interface OperationLogInput {
	level?: OperationLogLevel;
	area: string;
	operation: string;
	outcome: OperationLogEvent['outcome'];
	summary: string;
	actor?: OperationLogActor;
	dealId?: number;
	documents?: string[];
	details?: Record<string, OperationLogDetailValue>;
}

export class OperationLogService {
	constructor(
		private readonly store: OperationLogStore,
		private readonly warn: (message: string) => void,
	) {}

	async record(input: OperationLogInput): Promise<void> {
		const event: OperationLogEvent = {
			id: randomUUID(),
			occurredAt: new Date().toISOString(),
			level: input.level ?? (input.outcome === 'failure' ? 'error' : 'info'),
			area: input.area.slice(0, 80),
			operation: input.operation.slice(0, 80),
			outcome: input.outcome,
			summary: input.summary.slice(0, 1_000),
			...(input.actor ? { actor: { id: input.actor.id.slice(0, 40), name: input.actor.name.slice(0, 160) } } : {}),
			...(input.dealId && input.dealId > 0 ? { deal: { id: input.dealId } } : {}),
			...(input.documents?.length ? { documents: input.documents.map(String).filter(Boolean).slice(0, 50) } : {}),
			...(input.details ? { details: input.details } : {}),
		};
		try {
			await this.store.append(event);
		} catch (error) {
			this.warn(`Не удалось записать журнал операции: ${String(error)}`);
		}
	}

	list(filter: Parameters<OperationLogStore['list']>[0]): Promise<OperationLogEvent[]> {
		return this.store.list(filter);
	}
}
