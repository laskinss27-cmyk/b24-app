import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { runTildaAvailabilityPublication, selectTildaAvailabilityReport, type TildaPreparedAvailabilityReport } from './availability-publish-service.js';
import { TildaCommerceMlClient } from './commerce-ml-client.js';
import { readTildaPublicStockRows } from './public-catalog.js';

function required(name: string): string {
	const value = String(process.env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

if (String(process.env['TILDA_AVAILABILITY_SYNC'] ?? 'off').trim() !== 'manual') {
	throw new Error('TILDA_AVAILABILITY_SYNC=manual is required');
}

const reportPath = required('TILDA_AVAILABILITY_REPORT_PATH');
const auditPath = required('TILDA_AVAILABILITY_AUDIT_PATH');
const publicUrl = required('TILDA_PUBLIC_CATALOG_URL');
const client = new TildaCommerceMlClient({
	url: required('TILDA_COMMERCE_URL'),
	username: required('TILDA_COMMERCE_USERNAME'),
	password: required('TILDA_COMMERCE_PASSWORD'),
});
const report = selectTildaAvailabilityReport(
	JSON.parse(await readFile(reportPath, 'utf8')) as TildaPreparedAvailabilityReport,
	String(process.env['TILDA_AVAILABILITY_ONLY_UID'] ?? '').trim() || undefined,
);
const exchange = async (catalogXml: string, offersXml: string) => {
	const session = await client.authenticateAndInitialize();
	return client.uploadAndImportStock(session, catalogXml, offersXml);
};
const result = await runTildaAvailabilityPublication({
	report,
	confirmation: required('TILDA_AVAILABILITY_CONFIRMATION'),
}, {
	readPublicCatalog: () => readTildaPublicStockRows(publicUrl),
	publishProjection: exchange,
	publishRollback: exchange,
});
const temporaryPath = `${auditPath}.tmp`;
try {
	await writeFile(temporaryPath, `${JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	await rename(temporaryPath, auditPath);
} finally {
	await rm(temporaryPath, { force: true });
}
console.log(JSON.stringify(result));
