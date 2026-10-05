import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mariadb';
import { ReservationService } from './sql-service.js';
import type { ReservationRuntime } from './sql-runtime.js';

// Transactional SQL double: unexpected statements fail; failed commands restore all persisted state.
class Database {
	state = {
		reservation: { id: '1', status: 'active', version: 1, expires_at: '2099-01-01' },
		lines: [{ id: '11', active_qty: '5' }, { id: '12', active_qty: '3' }],
		releases: [] as Array<Record<string, unknown>>,
		commands: [] as Array<Record<string, unknown>>,
		events: [] as unknown[][],
	};
	async query<T>(sql: string, values: unknown[] = []): Promise<T> {
		const q = sql.replace(/\s+/g, ' ').trim();
		let out: unknown;
		if (q.startsWith('SELECT') && q.includes('FROM stock_reservations ')) out = [this.state.reservation];
		else if (q.startsWith('INSERT IGNORE INTO stock_reservation_commands')) {
			const exists = this.state.commands.some((row) => row['key'] === values[0]);
			if (!exists) this.state.commands.push({ key: values[0], id: String(this.state.commands.length + 1), request_hash: values[5], status: 'started' });
			out = { affectedRows: exists ? 0 : 1 };
		} else if (q.includes('FROM stock_reservation_commands')) out = this.state.commands.filter((row) => row['key'] === values[0]);
		else if (q.startsWith('UPDATE stock_reservation_commands SET status')) { this.state.commands.find((row) => row['id'] === values[4])!['status'] = values[0]; out = { affectedRows: 1 }; }
		else if (q.startsWith('UPDATE stock_reservation_commands SET release_request_id')) out = { affectedRows: 1 };
		else if (q.startsWith('SELECT') && q.includes('FROM stock_reservation_lines')) out = this.state.lines.filter((line) => !q.includes('active_qty > 0') || Number(line.active_qty) > 0);
		else if (q.startsWith('INSERT INTO stock_reservation_release_requests')) {
			const direct = q.includes("'approved'");
			this.state.releases.push({ id: String(this.state.releases.length + 1), reservation_id: values[1], status: direct ? 'approved' : 'pending', release_lines_json: values.at(-1) });
			out = { insertId: String(this.state.releases.length) };
		} else if (q.startsWith('SELECT') && q.includes('FROM stock_reservation_release_requests')) out = this.state.releases.filter((row) => q.includes("status = 'pending'") ? row['status'] === 'pending' : row['id'] === values[0]);
		else if (q.startsWith('UPDATE stock_reservation_release_requests')) { this.state.releases.find((row) => row['id'] === values[3])!['status'] = values[0]; out = { affectedRows: 1 }; }
		else if (q.startsWith('UPDATE stock_reservation_lines')) {
			const line = this.state.lines.find((row) => row.id === values[1])!;
			assert.ok(Number(line.active_qty) >= Number(values[0]));
			line.active_qty = String(Number(line.active_qty) - Number(values[0])); out = { affectedRows: 1 };
		} else if (q.startsWith('INSERT INTO stock_reservation_events')) { this.state.events.push(values); out = { affectedRows: 1 }; }
		else if (q.startsWith('UPDATE stock_reservations')) { if (values[0] === 0) this.state.reservation.status = 'released'; this.state.reservation.version++; out = { affectedRows: 1 }; }
		else throw new Error(`Unexpected SQL: ${q}`);
		return out as T;
	}
	service(): ReservationService {
		const db = this;
		return new ReservationService({ mode: 'active', enabled: true, canWrite: true,
			async transaction<T>(work: (connection: PoolConnection) => Promise<T>) {
				const snapshot = structuredClone(db.state);
				// Buffer must remain a Buffer for the command hash comparison.
				snapshot.commands.forEach((row) => { row['request_hash'] = Buffer.from(row['request_hash'] as Uint8Array); });
				try { return await work(db as unknown as PoolConnection); } catch (error) { db.state = snapshot; throw error; }
			},
		} as ReservationRuntime);
	}
}
const actor = { id: '7', name: 'Manager' };
const selection = [{ lineId: '11', quantity: '2' }];

test('direct partial release preserves remainder and other lines; replay cannot release twice', async () => {
	const db = new Database(); const service = db.service();
	await service.releaseBySupply(actor, '1', 'reason', 'once', selection);
	assert.deepEqual(db.state.lines.map((line) => line.active_qty), ['3', '3']);
	assert.equal(db.state.reservation.status, 'active');
	assert.equal(db.state.events[0]![4], '2');
	await service.releaseBySupply(actor, '1', 'reason', 'once', selection);
	assert.equal(db.state.events.length, 1);
	await assert.rejects(service.releaseBySupply(actor, '1', 'reason', 'once', [{ lineId: '11', quantity: '1' }]), /conflicts/);
	await service.releaseBySupply(actor, '1', '', 'rest');
	assert.equal(db.state.reservation.status, 'released');
});

test('request changes no quantities; approval uses saved selection and permits subsequent partial requests', async () => {
	const db = new Database(); const service = db.service();
	await service.requestRelease(actor, 20, '1', 'reason', 'request', selection);
	await service.requestRelease(actor, 20, '1', 'reason', 'request', selection);
	assert.equal(db.state.releases.length, 1);
	assert.equal(db.state.lines[0]!.active_qty, '5');
	await assert.rejects(service.requestRelease(actor, 20, '1', '', 'duplicate', selection), /уже есть запрос/);
	await assert.rejects(service.releaseBySupply(actor, '1', '', 'direct', selection), /Сначала согласуйте/);
	await service.reviewRelease(actor, { releaseRequestId: '1', decision: 'approve', idempotencyKey: 'review' });
	await service.reviewRelease(actor, { releaseRequestId: '1', decision: 'approve', idempotencyKey: 'retry' });
	assert.deepEqual(db.state.lines.map((line) => line.active_qty), ['3', '3']);
	assert.equal(db.state.events.length, 1);
	await service.requestRelease(actor, 20, '1', '', 'next', [{ lineId: '12', quantity: '1' }]);
	await service.reviewRelease(actor, { releaseRequestId: '2', decision: 'reject', idempotencyKey: 'reject' });
	assert.deepEqual(db.state.lines.map((line) => line.active_qty), ['3', '3']);
});

test('stale approval rolls back all changes and leaves request pending for rejection', async () => {
	const db = new Database(); const service = db.service();
	await service.requestRelease(actor, 20, '1', '', 'request', selection);
	db.state.lines[0]!.active_qty = '1';
	await assert.rejects(service.reviewRelease(actor, { releaseRequestId: '1', decision: 'approve' }), /Обновите/);
	assert.equal(db.state.releases[0]!['status'], 'pending');
	assert.equal(db.state.lines[1]!.active_qty, '3');
	assert.equal(db.state.events.length, 0);
});

test('legacy pending full release remains supported; expired approval fails without mutation', async () => {
	const db = new Database(); const service = db.service();
	db.state.releases.push({ id: '1', reservation_id: '1', status: 'pending', release_lines_json: null });
	db.state.reservation.expires_at = '2000-01-01';
	await assert.rejects(service.reviewRelease(actor, { releaseRequestId: '1', decision: 'approve' }), /не активен/);
	db.state.reservation.expires_at = '2099-01-01';
	await service.reviewRelease(actor, { releaseRequestId: '1', decision: 'approve' });
	assert.equal(db.state.reservation.status, 'released');
	assert.deepEqual(db.state.lines.map((line) => line.active_qty), ['0', '0']);
});

test('partial release preserves shortfall status; invalid multi-line release is atomic', async () => {
	const db = new Database(); const service = db.service();
	db.state.reservation.status = 'shortfall';
	await assert.rejects(service.releaseBySupply(actor, '1', '', 'invalid', [...selection, { lineId: '12', quantity: '4' }]));
	assert.deepEqual(db.state.lines.map((line) => line.active_qty), ['5', '3']);
	assert.equal(db.state.events.length, 0);
	await service.releaseBySupply(actor, '1', '', 'valid', selection);
	assert.equal(db.state.reservation.status, 'shortfall');
});
