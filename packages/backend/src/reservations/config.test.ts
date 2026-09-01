import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { loadReservationConfig } from './config.js';
import { createReservationRuntime } from './runtime.js';
import { registerApiReservationsRoute } from '../routes/api-reservations.js';

test('reservations are disabled when the flag is absent or explicitly off', () => {
	assert.deepEqual(loadReservationConfig({}), { mode: 'off' });
	assert.deepEqual(loadReservationConfig({ B24_APP_RESERVATIONS: 'off' }), { mode: 'off' });
});

const databaseEnv = {
	B24_APP_DB_MODE: 'readiness',
	B24_APP_DB_HOST: 'database',
	B24_APP_DB_NAME: 'b24_app',
	B24_APP_DB_USER: 'runtime_reader',
	B24_APP_DB_PASSWORD: 'reader-secret',
};

test('shadow reservations reuse the read-only runtime identity', () => {
	assert.deepEqual(loadReservationConfig({ ...databaseEnv, B24_APP_RESERVATIONS: 'shadow' }), {
		mode: 'shadow', host: 'database', port: 3306, database: 'b24_app',
		user: 'runtime_reader', password: 'reader-secret', connectionLimit: 4, connectTimeoutMs: 3000,
	});
});

test('active reservations require a separate DML identity', () => {
	assert.deepEqual(loadReservationConfig({
		...databaseEnv,
		B24_APP_RESERVATIONS: 'active',
		B24_APP_RESERVATION_DB_USER: 'reservation_writer',
		B24_APP_RESERVATION_DB_PASSWORD: 'writer-secret',
	}), {
		mode: 'active', host: 'database', port: 3306, database: 'b24_app',
		user: 'reservation_writer', password: 'writer-secret', connectionLimit: 4, connectTimeoutMs: 3000,
	});
	assert.throws(
		() => loadReservationConfig({ ...databaseEnv, B24_APP_RESERVATIONS: 'active' }),
		/B24_APP_RESERVATION_DB_USER is required/,
	);
	assert.throws(
		() => loadReservationConfig({
			...databaseEnv,
			B24_APP_RESERVATIONS: 'active',
			B24_APP_RESERVATION_DB_USER: 'runtime_reader',
			B24_APP_RESERVATION_DB_PASSWORD: 'writer-secret',
		}),
		/separate identity/,
	);
});

test('reservations reject unknown modes and an inactive application database', () => {
	assert.throws(() => loadReservationConfig({ B24_APP_RESERVATIONS: 'on' }), /must be off, shadow or active/);
	assert.throws(() => loadReservationConfig({ B24_APP_RESERVATIONS: 'shadow' }), /B24_APP_DB_MODE=readiness/);
});

test('reservation capability endpoint stays explicitly disabled in off mode', async () => {
	const app = Fastify();
	registerApiReservationsRoute(app, createReservationRuntime({ mode: 'off' }));
	const response = await app.inject({ method: 'POST', url: '/api/reservations/status', payload: {} });
	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), { ok: true, enabled: false, mode: 'off', canWrite: false });
	await app.close();
});
