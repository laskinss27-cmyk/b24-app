/**
 * Обновление точки пока строится как read-modify-write всей инвентаризации.
 * Поэтому параллельные обновления одного публичного номера идут последовательно
 * и в SQL-primary, и в совместимом Bitrix-режиме.
 */
const inventoryUpdateLocks = new Map<string, Promise<void>>();

export async function withInventoryUpdateLock<T>(inventoryId: string, work: () => Promise<T>): Promise<T> {
	const previous = inventoryUpdateLocks.get(inventoryId) ?? Promise.resolve();
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const tail = previous.catch(() => undefined).then(() => gate);
	inventoryUpdateLocks.set(inventoryId, tail);
	await previous.catch(() => undefined);
	try {
		return await work();
	} finally {
		release();
		if (inventoryUpdateLocks.get(inventoryId) === tail) inventoryUpdateLocks.delete(inventoryId);
	}
}
