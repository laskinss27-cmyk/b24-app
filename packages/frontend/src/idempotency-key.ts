export function newIdempotencyKey(prefix: string): string {
	const suffix = typeof globalThis.crypto?.randomUUID === 'function'
		? globalThis.crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}:${suffix}`;
}
