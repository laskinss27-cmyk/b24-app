import type { FastifyInstance, FastifyRequest } from 'fastify';

type RealizationOperation = 'draft' | 'submit' | 'return';

interface RealizationEventInput {
	operation: RealizationOperation;
	dealId: number;
	documents: string[];
	error?: string;
}

const ACTION_TEXT: Record<RealizationOperation, { success: string; failure: string }> = {
	draft: { success: 'Созданы черновики реализации', failure: 'Не удалось создать черновики реализации' },
	submit: { success: 'Проведена реализация', failure: 'Не удалось провести реализацию' },
	return: { success: 'Оформлен возврат', failure: 'Не удалось оформить возврат' },
};

function actorFrom(req: FastifyRequest): { id: string; name: string } | undefined {
	const user = req.appAccess?.user;
	return user ? { id: user.id, name: user.name } : undefined;
}

function documentSuffix(documents: string[]): string {
	if (!documents.length) return '';
	const visible = documents.slice(0, 5).join(', ');
	return ` — ${visible}${documents.length > 5 ? ` и ещё ${documents.length - 5}` : ''}`;
}

export async function recordRealizationEvent(
	app: FastifyInstance,
	req: FastifyRequest,
	input: RealizationEventInput,
): Promise<void> {
	const failed = Boolean(input.error);
	const text = ACTION_TEXT[input.operation][failed ? 'failure' : 'success'];
	const actor = actorFrom(req);
	await app.operationLog.record({
		area: 'realizations',
		operation: input.operation,
		outcome: failed ? 'failure' : 'success',
		summary: `${text} по сделке №${input.dealId}${documentSuffix(input.documents)}${input.error ? `: ${input.error}` : ''}`,
		...(actor ? { actor } : {}),
		dealId: input.dealId,
		documents: input.documents,
		details: { documentCount: input.documents.length },
	});
}
