import { isDeepStrictEqual } from 'node:util';

type DraftRequest = { draft?: Record<string, number>; draftSessionId?: string; draftSequence?: number };
type Decision = { kind: 'write' | 'already_saved' } | { kind: 'reject'; code: string; error: string };

/** No mutation: acknowledge a retry only when these exact facts are already persisted. */
export function inventoryDraftSaveDecision(
	point: Record<string, unknown>, request: DraftRequest, comments: Record<string, string> | null, rootStatus: unknown,
): Decision {
	const status = String(point['status'] ?? 'idle');
	if (rootStatus === 'closed' || !['idle', 'in_progress', 'act'].includes(status)) {
		return { kind: 'reject', code: 'INVENTORY_DRAFT_LOCKED', error: 'Черновик не сохранён: ревизия уже отправлена или закрыта. Попросите ответственного вернуть её в работу. Не закрывайте эту вкладку и не очищайте данные браузера.' };
	}
	const session = String(request.draftSessionId ?? '').trim().slice(0, 80);
	const sequence = Number(request.draftSequence ?? 0);
	const storedSequence = Number(point['draftSequence'] ?? 0);
	if (session && session === String(point['draftSessionId'] ?? '') && Number.isInteger(sequence) && sequence <= storedSequence) {
		if (sequence === storedSequence && isDeepStrictEqual(request.draft ?? {}, point['draft'] ?? {})
			&& (comments === null || isDeepStrictEqual(comments, point['comments'] ?? {}))) {
			return { kind: 'already_saved' };
		}
		return { kind: 'reject', code: 'INVENTORY_DRAFT_OUTDATED', error: 'Черновик не сохранён: сервер уже получил другую или более новую версию. Не закрывайте вкладку и не обновляйте страницу; обратитесь к ответственному для сверки.' };
	}
	// Existing open clients keep their current request contract, including legacy requests without a sequence.
	return { kind: 'write' };
}
