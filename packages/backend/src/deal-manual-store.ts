import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanLine } from './erp/deal-plan-state.js';

interface ManualState { version: 1; lines: PlanLine[]; variants?: string }
const queues = new Map<string, Promise<unknown>>();
const directory = (): string => join(process.env['B24_STATE_DIR'] ?? '/app/state', 'deal-manual');
function pathFor(dealId: number): string {
	if (!Number.isSafeInteger(dealId) || dealId <= 0) throw new Error('bad dealId');
	return join(directory(), `${dealId}.json`);
}

/** These negative IDs identify quote lines only; they must never reach a catalog or stock API. */
export function newManualProductId(): number { return -parseInt(randomUUID().replaceAll('-', '').slice(0, 12), 16) - 1; }

export function validateManualLine(line: PlanLine): void {
	if (line.manual !== true || !Number.isSafeInteger(line.productId) || line.productId >= 0
		|| !line.itemName?.trim() || line.itemName.length > 500 || !line.unit?.trim() || line.unit.length > 20
		|| !Number.isFinite(line.qty) || line.qty <= 0 || !Number.isFinite(line.priceListRate) || line.priceListRate < 0
		|| !Number.isFinite(line.discountPercent) || line.discountPercent < 0 || line.discountPercent > 100
		|| line.isService) throw new Error('Проверьте название, единицу, количество, цену и скидку ручной строки');
}

export async function readManualState(dealId: number): Promise<ManualState | null> {
	try {
		const state = JSON.parse(await readFile(pathFor(dealId), 'utf8')) as ManualState;
		if (state.version !== 1 || !Array.isArray(state.lines) || (state.variants !== undefined && typeof state.variants !== 'string')) throw new Error('Повреждены ручные строки сделки');
		state.lines.forEach(validateManualLine);
		if (new Set(state.lines.map((line) => line.productId)).size !== state.lines.length) throw new Error('Повторяются идентификаторы ручных строк');
		return state;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export async function writeManualState(dealId: number, patch: Partial<Pick<ManualState, 'lines' | 'variants'>>): Promise<void> {
	const path = pathFor(dealId);
	const task = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
		const state = { version: 1 as const, lines: [], ...await readManualState(dealId), ...patch };
		state.lines.forEach(validateManualLine);
		if (new Set(state.lines.map((line) => line.productId)).size !== state.lines.length) throw new Error('Повторяются идентификаторы ручных строк');
		await mkdir(directory(), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
			await rename(temporary, path);
		} finally { await rm(temporary, { force: true }); }
	});
	queues.set(path, task);
	try { await task; } finally { if (queues.get(path) === task) queues.delete(path); }
}
