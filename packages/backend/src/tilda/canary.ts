import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { TildaCommerceMlClient } from './commerce-ml-client.js';
import { readTildaPublicStockRows } from './public-catalog.js';
import { runTildaStockCanary, type TildaPreparedStockReport } from './stock-canary-service.js';

const required = (name: string): string => {
	const value = String(process.env[name] ?? '').trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const reportPath = required('TILDA_CANARY_REPORT_PATH');
const auditPath = required('TILDA_CANARY_AUDIT_PATH');
const publicUrl = required('TILDA_PUBLIC_CATALOG_URL');
const client = new TildaCommerceMlClient({
	url: required('TILDA_COMMERCE_URL'),
	username: required('TILDA_COMMERCE_USERNAME'),
	password: required('TILDA_COMMERCE_PASSWORD'),
});
const report = JSON.parse(await readFile(reportPath, 'utf8')) as TildaPreparedStockReport;
const session = await client.authenticateAndInitialize();
const result = await runTildaStockCanary({
	report,
	tildaUid: required('TILDA_CANARY_UID'),
	confirmation: required('TILDA_CANARY_CONFIRMATION'),
}, {
	readPublicCatalog: () => readTildaPublicStockRows(publicUrl),
	publishExchange: (catalogXml, offersXml) => client.uploadAndImportStock(session, catalogXml, offersXml),
	afterPublish: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
});
const temporaryPath = `${auditPath}.tmp`;
try {
	await writeFile(temporaryPath, `${JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	await rename(temporaryPath, auditPath);
} finally {
	await rm(temporaryPath, { force: true });
}
console.log(JSON.stringify(result));
