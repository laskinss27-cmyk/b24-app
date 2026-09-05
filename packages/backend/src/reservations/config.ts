export type ReservationConfig =
	| { mode: 'off' }
	| {
		mode: 'shadow' | 'active';
		host: string;
		port: number;
		database: string;
		user: string;
		password: string;
		connectionLimit: number;
		connectTimeoutMs: number;
	};

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = String(env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required when reservations are enabled`);
	return value;
}

function positiveInteger(value: unknown, fallback: number, max: number, name: string): number {
	const parsed = value == null || value === '' ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) throw new Error(`${name} must be a positive integer <= ${max}`);
	return parsed;
}

/** `shadow` only reads projections; `active` requires a separate DML identity. */
export function loadReservationConfig(env: NodeJS.ProcessEnv = process.env): ReservationConfig {
	const mode = String(env['B24_APP_RESERVATIONS'] ?? 'off').trim();
	if (mode === 'off') return { mode: 'off' };
	if (mode !== 'shadow' && mode !== 'active') throw new Error('B24_APP_RESERVATIONS must be off, shadow or active');
	if (String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required when reservations are enabled');
	}
	const runtimeUser = required(env, 'B24_APP_DB_USER');
	const user = mode === 'active' ? required(env, 'B24_APP_RESERVATION_DB_USER') : runtimeUser;
	const password = mode === 'active' ? required(env, 'B24_APP_RESERVATION_DB_PASSWORD') : required(env, 'B24_APP_DB_PASSWORD');
	if (mode === 'active') {
		const forbidden = [runtimeUser, env['B24_APP_MIGRATION_DB_USER'], env['B24_APP_BACKFILL_DB_USER'], env['B24_APP_TILDA_DB_USER'], env['B24_APP_INVENTORY_DB_USER']]
			.map((value) => String(value ?? '').trim())
			.filter(Boolean);
		if (forbidden.includes(user)) throw new Error('Reservation runtime database user must be a separate identity');
	}
	return {
		mode,
		host: required(env, 'B24_APP_DB_HOST'),
		port: positiveInteger(env['B24_APP_DB_PORT'], 3306, 65_535, 'B24_APP_DB_PORT'),
		database: required(env, 'B24_APP_DB_NAME'),
		user,
		password,
		connectionLimit: positiveInteger(env['B24_APP_RESERVATION_DB_CONNECTION_LIMIT'], 4, 20, 'B24_APP_RESERVATION_DB_CONNECTION_LIMIT'),
		connectTimeoutMs: positiveInteger(env['B24_APP_DB_CONNECT_TIMEOUT_MS'], 3_000, 30_000, 'B24_APP_DB_CONNECT_TIMEOUT_MS'),
	};
}
