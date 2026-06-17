/** Read-only: принимает ли sale.shipment.list фильтр по диапазону дат и в каком формате. */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function cnt(label: string, filter: Record<string, unknown>): Promise<void> {
	try {
		const r = await c.call<{ shipments?: unknown[] }>('sale.shipment.list', { select: ['id', 'accountNumber', 'dateInsert', 'dateDeducted'], filter, order: { id: 'DESC' } });
		const arr = r?.shipments ?? [];
		console.log(`  ${label}: ${arr.length} стр.`, arr[0] ? `первая ${JSON.stringify(arr[0])}` : '');
	} catch (e) { console.log(`  ⛔ ${label} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); }
}
(async () => {
	console.log('Базовый (deducted=Y, system=N):'); await cnt('all', { deducted: 'Y', system: 'N' });
	console.log('Фильтр по dateDeducted (YYYY-MM-DD):');
	await cnt('>=2026-06-09 & <=2026-06-09', { deducted: 'Y', system: 'N', '>=dateDeducted': '2026-06-09', '<=dateDeducted': '2026-06-09' });
	await cnt('>=2026-06-10', { deducted: 'Y', system: 'N', '>=dateDeducted': '2026-06-10' });
	console.log('Фильтр по dateInsert (YYYY-MM-DD):');
	await cnt('>=2026-06-09 & <=2026-06-09', { deducted: 'Y', system: 'N', '>=dateInsert': '2026-06-09', '<=dateInsert': '2026-06-09' });
	console.log('Формат с временем (<= конец дня):');
	await cnt('>=2026-06-09T00:00:00 & <=2026-06-09T23:59:59', { deducted: 'Y', system: 'N', '>=dateDeducted': '2026-06-09T00:00:00', '<=dateDeducted': '2026-06-09T23:59:59' });
})().catch((e) => console.error('FATAL', e));
