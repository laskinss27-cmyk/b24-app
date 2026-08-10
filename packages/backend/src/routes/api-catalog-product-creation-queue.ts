let createProductQueue: Promise<void> = Promise.resolve();

export async function serializeProductCreate<T>(action: () => Promise<T>): Promise<T> {
	const previous = createProductQueue;
	let release!: () => void;
	createProductQueue = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try { return await action(); } finally { release(); }
}
