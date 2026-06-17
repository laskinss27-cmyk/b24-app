/**
 * Read-only: ищем недавнее изменение остатка — свежие складские документы (вдруг случайно провели).
 * Запуск: npx tsx scripts/recon-find-stock-change.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2000) s = s.slice(0, 2000) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	console.log('=== 10 свежих складских документов (id↓) ===');
	const docs = await tc<{ documents?: Array<Record<string, unknown>> }>('catalog.document.list', {
		select: ['id', 'docType', 'status', 'title', 'dateCreate', 'dateModify', 'createdBy', 'wasConducted'],
		order: { id: 'DESC' },
	});
	const list = (docs?.documents ?? []).slice(0, 10);
	for (const d of list) {
		console.log(`  #${d['id']} | тип=${d['docType']} | статус=${d['status']} | создан=${d['dateCreate']} | кем=${d['createdBy']} | "${String(d['title'] ?? '').slice(0,40)}"`);
	}
	console.log('\n=== строки 3 самых свежих документов (что и куда двигали) ===');
	for (const d of list.slice(0, 3)) {
		const els = await tc<{ documentElements?: Array<Record<string, unknown>> }>('catalog.document.element.list', { filter: { docId: Number(d['id']) } });
		console.log(`  -- документ #${d['id']} (${d['docType']}, ${d['status']}) --`);
		for (const e of (els?.documentElements ?? []).slice(0, 8)) {
			console.log(`     товар ${e['elementId']} | amount=${e['amount']} | storeFrom=${e['storeFrom']} | storeTo=${e['storeTo']}`);
		}
	}
})().catch((e) => console.error('FATAL', e));
