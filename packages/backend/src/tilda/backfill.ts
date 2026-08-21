import { fileURLToPath } from 'node:url';
import { createDatabasePool } from '../database/runtime.js';
import { loadBackfillDatabaseConfig } from '../database/config.js';
import { backfillTildaProductMappings } from './product-mapping-backfill.js';
import { readTildaProductMappingSeed } from './product-mapping-seed.js';

const seedPath = fileURLToPath(new URL('../../migrations/data/tilda-product-mappings-2026-08-21.csv', import.meta.url));
const pool = createDatabasePool(loadBackfillDatabaseConfig());
const connection = await pool.getConnection();
try {
	const result = await backfillTildaProductMappings(connection, await readTildaProductMappingSeed(seedPath));
	console.log(`Tilda mapping backfill complete: ${JSON.stringify(result)}`);
} finally {
	await connection.release();
	await pool.end();
}
