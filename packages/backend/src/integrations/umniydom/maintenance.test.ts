import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { OrdersStore } from './store.js';
import { backupQueue, verifySnapshot } from './maintenance.js';

test('maintenance backs up and verifies both queue schemas without network or live databases', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'order-maintenance-'));
	try {
		for (const enabled of [false, true]) {
			const path = join(dir, String(enabled) + '.sqlite');
			const store = new OrdersStore(path, 'sandbox', randomUUID(), enabled);
			store.close();
			const destination = join(dir, 'backup-' + enabled);
			const result = await backupQueue(path, destination);
			assert.equal(result.inbox, 0); assert.equal(result.pending, 0);
			assert.deepEqual(verifySnapshot(join(destination, 'orders.sqlite')), result);
			assert.equal(JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')).version, 1);
			const db = new DatabaseSync(join(destination, 'orders.sqlite'));
			try {
				assert.equal(db.prepare('SELECT version FROM orders_meta').get()!['version'], enabled ? 2 : 1);
				if (enabled) db.exec('DROP TABLE orders_status_current');
				else db.exec('UPDATE orders_meta SET version=99');
			} finally { db.close(); }
			assert.throws(() => verifySnapshot(join(destination, 'orders.sqlite')));
			await assert.rejects(backupQueue(path, destination));
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
