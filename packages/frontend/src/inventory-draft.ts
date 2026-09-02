export type InventoryDraftMode = 'count' | 'act';

export interface InventoryLocalDraft {
	version: 1;
	inventoryId: string;
	storeId: number;
	mode: InventoryDraftMode;
	draft: Record<number, number>;
	comments: Record<number, string>;
	updatedAt: string;
	pending: boolean;
}

export function inventoryDraftStorageKey(inventoryId: string, storeId: number, mode: InventoryDraftMode): string {
	return `b24-app:inventory-draft:v1:${inventoryId}:${storeId}:${mode}`;
}

function storage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function numericDraft(value: unknown): Record<number, number> {
	if (!value || typeof value !== 'object') return {};
	const out: Record<number, number> = {};
	for (const [rawId, rawQty] of Object.entries(value as Record<string, unknown>)) {
		const id = Number(rawId);
		const qty = Number(rawQty);
		if (Number.isInteger(id) && id > 0 && Number.isFinite(qty) && qty >= 0) out[id] = qty;
	}
	return out;
}

function textComments(value: unknown): Record<number, string> {
	if (!value || typeof value !== 'object') return {};
	const out: Record<number, string> = {};
	for (const [rawId, rawText] of Object.entries(value as Record<string, unknown>)) {
		const id = Number(rawId);
		const text = typeof rawText === 'string' ? rawText.slice(0, 500) : '';
		if (Number.isInteger(id) && id > 0 && text) out[id] = text;
	}
	return out;
}

export function readInventoryLocalDraft(key: string): InventoryLocalDraft | null {
	try {
		const raw = storage()?.getItem(key);
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<InventoryLocalDraft>;
		if (value.version !== 1 || !value.inventoryId || !Number.isInteger(value.storeId)) return null;
		if (value.mode !== 'count' && value.mode !== 'act') return null;
		return {
			version: 1,
			inventoryId: String(value.inventoryId),
			storeId: Number(value.storeId),
			mode: value.mode,
			draft: numericDraft(value.draft),
			comments: textComments(value.comments),
			updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
			pending: value.pending === true,
		};
	} catch {
		return null;
	}
}

export function writeInventoryLocalDraft(key: string, value: InventoryLocalDraft): void {
	try {
		storage()?.setItem(key, JSON.stringify(value));
	} catch {
		// Серверное автосохранение продолжит работать, даже если браузер запретил localStorage.
	}
}

export function clearInventoryLocalDraft(key: string): void {
	try {
		storage()?.removeItem(key);
	} catch {
		// Нечего восстанавливать: закрытый storage не должен ломать отправку отчёта.
	}
}

export function countsToDraft(counts: Record<number, string>): Record<number, number> {
	const out: Record<number, number> = {};
	for (const [rawId, rawQty] of Object.entries(counts)) {
		if (rawQty === '') continue;
		const id = Number(rawId);
		const qty = Number(rawQty);
		if (Number.isInteger(id) && id > 0 && Number.isFinite(qty) && qty >= 0) out[id] = qty;
	}
	return out;
}

export interface InventoryCountSourceLine {
	productId: number;
	name: string;
	book: number;
}

export interface EnteredInventoryDifference {
	productId: number;
	name: string;
	book: number;
	fact: number;
	diff: number;
	comment?: string;
}

/** Blank means "not counted": only explicitly entered quantities can become discrepancies. */
export function enteredInventoryDifferences(
	lines: InventoryCountSourceLine[],
	counts: Record<number, string>,
	comments: Record<number, string>,
): EnteredInventoryDifference[] {
	const differences: EnteredInventoryDifference[] = [];
	for (const line of lines) {
		const rawFact = counts[line.productId];
		if (rawFact === undefined || rawFact === '') continue;
		const fact = Number(rawFact);
		if (!Number.isFinite(fact) || fact < 0 || fact === line.book) continue;
		const comment = comments[line.productId]?.trim().slice(0, 500);
		differences.push({
			productId: line.productId,
			name: line.name,
			book: line.book,
			fact,
			diff: fact - line.book,
			...(comment ? { comment } : {}),
		});
	}
	return differences;
}

export function inventoryLineNeedsAttention(book: number, entered: string | undefined): boolean {
	return entered === undefined || entered === '' || Number(entered) !== book;
}

export function commentsToDraft(comments: Record<number, string>): Record<number, string> {
	const out: Record<number, string> = {};
	for (const [rawId, rawText] of Object.entries(comments)) {
		const id = Number(rawId);
		const text = rawText.trim().slice(0, 500);
		if (Number.isInteger(id) && id > 0 && text) out[id] = text;
	}
	return out;
}
