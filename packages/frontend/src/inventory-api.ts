import { bx24Auth } from './bitrix-auth.js';

export type InvPointStatus = 'idle' | 'in_progress' | 'submitted' | 'act' | 'reconciled';

/** Строка результата подсчёта (храним только расхождения — для сводки инициатора). */
export interface InvResultLine {
	productId: number;
	name: string;
	book: number;
	fact: number;
	diff: number;
	/** Пояснение проверяющего к конкретной позиции. */
	comment?: string;
}
export interface InvResult {
	counted: number;
	total: number;
	discrepancies: number;
	lines: InvResultLine[];
}

export interface InvPoint {
	storeId: number;
	storeName: string;
	responsibleId: string;
	responsibleName: string;
	/** Нет поля → трактуем как 'idle' (обратная совместимость со старыми записями). */
	status?: InvPointStatus;
	startedAt?: string;
	submittedAt?: string;
	/** Когда инициатор сформировал акт разногласий. */
	actAt?: string;
	result?: InvResult;
	/** Промежуточный подсчёт (productId → факт), чтобы можно было вернуться позже. */
	draft?: Record<number, number>;
	/** Комментарии проверяющего по позициям (productId → текст). */
	comments?: Record<number, string>;
	/** Последнее успешное серверное автосохранение черновика. */
	draftUpdatedAt?: string;
	draftUpdatedById?: string;
	draftUpdatedByName?: string;
	/** Legacy Stock Reconciliation у ревизий, созданных до разделения документов. */
	erpDoc?: ErpInvDoc;
	/** New documents: inventory shortage issue and inventory surplus receipt. */
	erpDocs?: ErpInvDocuments;
}

export interface ErpInvDoc {
	name: string;
	status: 'draft' | 'submitted';
	lines: number;
	savedAt?: string;
	submittedAt?: string;
}
export interface ErpInvDocuments {
	issue?: ErpInvDoc;
	receipt?: ErpInvDoc;
}
export interface ErpInvDocumentState {
	docs: ErpInvDocuments;
	/** Legacy Stock Reconciliation, retained for inventories that already created it. */
	legacyDoc: ErpInvDoc | null;
}
export interface Inventory {
	id: string;
	title: string;
	status: string;
	/** Крайний срок сдачи (YYYY-MM-DD). Пусто — без срока. */
	deadline: string;
	points: InvPoint[];
	createdById: string;
	createdAt: string;
	/** Охват инвентаризации (#13): id разделов каталога. Пусто/нет — весь склад. */
	sectionIds?: number[];
}

export async function listInventories(): Promise<Inventory[]> {
	const res = await fetch('/api/inventory/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(bx24Auth()),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; inventories?: Inventory[] };
	if (!json.ok) throw new Error(json.error ?? 'ошибка хранилища');
	return json.inventories ?? [];
}

export async function createInventory(
	title: string,
	points: InvPoint[],
	deadline: string,
	createdById: string,
	notifyUserIds: string[],
	sectionIds: number[],
): Promise<void> {
	const res = await fetch('/api/inventory/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), title, points, deadline, createdById, notifyUserIds, sectionIds }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить');
}

/** Обновление одной точки (claim / saveDraft / submit) — через бэкенд, entity. */
interface InventoryUpdateResponse {
	draftUpdatedAt?: string | null;
	ignored?: boolean;
}

async function postInventoryUpdate(payload: Record<string, unknown>, keepalive = false): Promise<InventoryUpdateResponse> {
	const res = await fetch('/api/inventory/update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...payload }),
		keepalive,
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & InventoryUpdateResponse;
	if (!json.ok) throw new Error(json.error ?? 'не удалось обновить точку');
	return json;
}

/** «Начал выполнение» — менеджер берёт точку себе (становится ответственным, статус «в работе»). */
export async function claimPoint(inventoryId: string, storeId: number, userId: string, userName: string): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'claim', userId, userName });
}
/** Сохранить промежуточный подсчёт (черновик факта). */
export async function saveDraftPoint(
	inventoryId: string,
	storeId: number,
	userId: string,
	draft: Record<number, number>,
	comments: Record<number, string>,
	options?: { userName?: string; sessionId?: string; sequence?: number; keepalive?: boolean },
): Promise<InventoryUpdateResponse> {
	return postInventoryUpdate({
		inventoryId,
		storeId,
		action: 'saveDraft',
		userId,
		userName: options?.userName,
		draft,
		comments,
		draftSessionId: options?.sessionId,
		draftSequence: options?.sequence,
	}, options?.keepalive === true);
}
/** «Отправить» — результат точки (статус «отправлено», либо «сверено» если был акт) + факты раунда. */
export async function submitPoint(
	inventoryId: string,
	storeId: number,
	userId: string,
	userName: string,
	result: InvResult,
	facts: Record<number, number>,
	comments: Record<number, string>,
): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'submit', userId, userName, result, facts, comments });
}

/** «Сформировать акт разногласий» (инициатор) — точка уходит менеджеру на сверку. */
export async function makeActPoint(inventoryId: string, storeId: number, userId: string): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'makeAct', userId });
}

/** «Вернуть в работу» (инициатор) — точка из отправлено/акт/сверено снова в работу, цифры сохранены. */
export async function reopenPoint(inventoryId: string, storeId: number, userId: string): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'reopen', userId });
}

/** Удалить инвентаризацию целиком (необратимо) — через бэкенд, entity.item.delete. */
export async function deleteInventory(inventoryId: string): Promise<void> {
	const res = await fetch('/api/inventory/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), inventoryId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить');
}

// ── Складские документы инвентаризации ───────────────────────────────────────

export interface ErpRecoLine {
	productId: number;
	name: string;
	bookErp: number;
	fact: number;
	diff: number;
}

async function postErpDoc<T>(path: string, payload: Record<string, unknown>): Promise<T> {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...payload }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & T;
	if (!json.ok) throw new Error(json.error ?? 'ошибка документа ядра');
	return json;
}

/** Болванка: строки документа ядра, ничего не записано (1С: «не сохранил — пропала»). */
function inventoryDocumentState(response: { docs?: ErpInvDocuments; legacyDoc?: ErpInvDoc | null; doc?: ErpInvDoc | null }): ErpInvDocumentState {
	return {
		docs: response.docs ?? {},
		legacyDoc: response.legacyDoc ?? response.doc ?? null,
	};
}

export async function previewErpDoc(inventoryId: string, storeId: number): Promise<{ lines: ErpRecoLine[] } & ErpInvDocumentState> {
	const j = await postErpDoc<{ lines?: ErpRecoLine[]; docs?: ErpInvDocuments; legacyDoc?: ErpInvDoc | null; doc?: ErpInvDoc | null }>('/api/inventory/erp-doc-preview', { inventoryId, storeId });
	return { lines: j.lines ?? [], ...inventoryDocumentState(j) };
}

/** Создать черновики списания недостачи и/или оприходования излишков. */
export async function saveErpDoc(inventoryId: string, storeId: number, recreate = false): Promise<ErpInvDocumentState> {
	const j = await postErpDoc<{ docs?: ErpInvDocuments; legacyDoc?: ErpInvDoc | null; doc?: ErpInvDoc | null }>('/api/inventory/erp-doc-save', { inventoryId, storeId, recreate });
	const state = inventoryDocumentState(j);
	if (!Object.keys(state.docs).length && !state.legacyDoc) throw new Error('бэкенд не вернул складские документы');
	return state;
}

/** Провести все необходимые документы; уже проведённые при повторе пропускаются. */
export async function submitErpDoc(inventoryId: string, storeId: number): Promise<ErpInvDocumentState> {
	const j = await postErpDoc<{ docs?: ErpInvDocuments; legacyDoc?: ErpInvDoc | null; doc?: ErpInvDoc | null }>('/api/inventory/erp-doc-submit', { inventoryId, storeId });
	const state = inventoryDocumentState(j);
	if (!Object.keys(state.docs).length && !state.legacyDoc) throw new Error('бэкенд не вернул складские документы');
	return state;
}
