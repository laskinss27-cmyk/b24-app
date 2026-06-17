import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
const PID = 16836;
(async () => {
	const prod = await tc<{ product?: Record<string, unknown> }>('catalog.product.get', { id: PID });
	console.log('ТОВАР', PID, ':', prod?.product?.['name']);
	const sp = await tc<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', { filter: { productId: PID }, select: ['storeId', 'amount', 'quantityReserved'] });
	console.log('ОСТАТКИ по складам:');
	for (const s of sp?.storeProducts ?? []) console.log(`  склад ${s['storeId']}: amount=${s['amount']} reserved=${s['quantityReserved']}`);
	const els = await tc<{ documentElements?: Array<Record<string, unknown>> }>('catalog.document.element.list', { filter: { elementId: PID }, order: { id: 'DESC' } });
	const arr = els?.documentElements ?? [];
	console.log(`СТРОК ДОКУМЕНТОВ по товару ${PID}: ${arr.length} (свежие)`);
	for (const e of arr.slice(0, 8)) console.log(`  docId=${e['docId']} amount=${e['amount']} storeFrom=${e['storeFrom']} storeTo=${e['storeTo']}`);
})().catch((e) => console.error('FATAL', e));
