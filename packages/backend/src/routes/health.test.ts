import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { readReleaseInfo, registerHealthRoute } from './health.js';

test('release identity comes from the baked-in file; missing development metadata is explicit', (t) => {
	const root = mkdtempSync(join(tmpdir(), 'b24-health-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = pathToFileURL(join(root, 'release.json'));
	assert.deepEqual(readReleaseInfo(path), { gitSha: null, gitTree: null, builtAt: null });
	const release = { gitSha: 'a'.repeat(40), gitTree: 'b'.repeat(40), builtAt: '2026-09-27T00:00:00.000Z' };
	writeFileSync(path, JSON.stringify({ ...release, internalField: 'not public' }));
	assert.deepEqual(readReleaseInfo(path), release);
	writeFileSync(path, JSON.stringify({ ...release, gitSha: 'latest' }));
	assert.throws(() => readReleaseInfo(path), /Invalid release.json/);
});

test('health preserves existing fields and exposes Git provenance without credentials', async () => {
	const app = Fastify();
	app.decorate('config', {
		portalDomain: 'portal.example.invalid', nodeEnv: 'test', port: 8080, host: '127.0.0.1',
		publicBaseUrl: 'https://app.example.invalid', appSectionUrl: '/app', inventoryNotify: 'off',
	});
	registerHealthRoute(app);
	try {
		const response = await app.inject('/health');
		assert.equal(response.statusCode, 200);
		const body = response.json();
		assert.equal(body.ok, true);
		assert.equal(body.portalDomain, 'portal.example.invalid');
		assert.deepEqual(Object.keys(body).sort(), ['ok', 'version', 'gitSha', 'gitTree', 'builtAt', 'portalDomain', 'nodeEnv', 'timestamp'].sort());
	} finally { await app.close(); }
});
