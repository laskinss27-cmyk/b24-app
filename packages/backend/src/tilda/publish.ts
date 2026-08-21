import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { TildaCommerceMlClient } from './commerce-ml-client.js';
import { readTildaPublicStockRows } from './public-catalog.js';
import { runTildaStockPublication, selectTildaPublicationReport } from './stock-publish-service.js';

const required = (name: string): string => {
	const value = String(process.env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const reportPath = required('TILDA_PUBLISH_REPORT_PATH');
const auditPath = required('TILDA_PUBLISH_AUDIT_PATH');
const publicUrl = required('TILDA_PUBLIC_CATALOG_URL');
const client = new TildaCommerceMlClient({
	url: required('TILDA_COMMERCE_URL'),
	username: required('TILDA_COMMERCE_USERNAME'),
	password: required('TILDA_COMMERCE_PASSWORD'),
});
const report = selectTildaPublicationReport(
	JSON.parse(await readFile(reportPath, 'utf8')),
	String(process.env['TILDA_PUBLISH_ONLY_UID'] ?? '').trim() || undefined,
);
const result = await runTildaStockPublication({
	report,
	confirmation: required('TILDA_PUBLISH_CONFIRMATION'),
}, {
	readPublicCatalog: () => readTildaPublicStockRows(publicUrl),
	publishProjection: async (catalogXml, offersXml) => {
		const session = await client.authenticateAndInitialize();
		return client.uploadAndImportStock(session, catalogXml, offersXml);
	},
	publishRollback: async (catalogXml, offersXml) => {
		const session = await client.authenticateAndInitialize();
		return client.uploadAndImportStock(session, catalogXml, offersXml);
	},
});
const temporaryPath = `${auditPath}.tmp`;
try {
	await writeFile(temporaryPath, `${JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	await rename(temporaryPath, auditPath);
} finally {
	await rm(temporaryPath, { force: true });
}
console.log(JSON.stringify(result));
