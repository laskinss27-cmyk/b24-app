// Additive migration. Run once with the dedicated migration identity before deploying partial release.
import mariadb from 'mariadb';
const required = (name) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const connection = await mariadb.createConnection({
	host: required('B24_APP_DB_HOST'), port: Number(process.env.B24_APP_DB_PORT || 3306),
	database: required('B24_APP_DB_NAME'), user: required('B24_APP_MIGRATION_DB_USER'),
	password: required('B24_APP_MIGRATION_DB_PASSWORD'),
});
try {
	await connection.query('ALTER TABLE stock_reservation_release_requests ADD COLUMN IF NOT EXISTS release_lines_json JSON NULL');
	const rows = await connection.query("SHOW COLUMNS FROM stock_reservation_release_requests LIKE 'release_lines_json'");
	if (rows.length !== 1) throw new Error('Migration verification failed');
	console.log('Reservation release selection column ready; existing requests preserved.');
} finally { await connection.end(); }
