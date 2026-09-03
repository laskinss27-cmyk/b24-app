import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCatalogMirrorReadMode } from './read-config.js';

test('SQL catalog read cutover is off by default and requires database readiness', () => {
	assert.equal(loadCatalogMirrorReadMode({}), 'off');
	assert.equal(loadCatalogMirrorReadMode({ B24_APP_DB_MODE: 'readiness', B24_APP_CATALOG_SQL_READ: 'shadow' }), 'shadow');
	assert.equal(loadCatalogMirrorReadMode({ B24_APP_DB_MODE: 'readiness', B24_APP_CATALOG_SQL_READ: 'primary' }), 'primary');
	assert.throws(() => loadCatalogMirrorReadMode({ B24_APP_CATALOG_SQL_READ: 'primary' }), /readiness/);
	assert.throws(() => loadCatalogMirrorReadMode({ B24_APP_CATALOG_SQL_READ: 'yes' }), /off, shadow or primary/);
});
