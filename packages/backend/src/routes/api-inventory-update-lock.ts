/**
 * ctv_inv хранит все точки одной инвентаризации в одной JSON-записи. Поэтому
 * параллельные read-modify-write обновления одной записи идут последовательно.
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
