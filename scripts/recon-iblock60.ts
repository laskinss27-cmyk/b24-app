/**
 * Read-only: справочник складов процесса снабжения (iblock 60) — каким API читается
 * и совпадают ли имена со складами каталога (catalog.store.list).
 * Известные значения: 7390, 7392, 7396, 7400, 7410 («Максидом Дунайский 64» и т.п.)
 * Запуск: npx tsx scripts/recon-iblock60.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { const r = await c.call<T>(m, p); console.log(`  ✅ ${m}`); return r; }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? `${e.code}:${(e.description ?? '').slice(0, 100)}` : String(e)}`); return null; }
}

(async () => {
	console.log('=== lists.element.get с разными IBLOCK_TYPE_ID ===');
	for (const t of ['lists', 'bitrix_processes', 'lists_socnet']) {
		const r = await tc<Array<Record<string, unknown>>>('lists.element.get', { IBLOCK_TYPE_ID: t, IBLOCK_ID: 60 });
		if (r) {
			for (const e of (r ?? []).slice(0, 15)) console.log(`    [${e['ID']}] «${e['NAME']}»`);
			break;
		}
	}

	console.log('\n=== склады каталога для сверки имён ===');
	const st = await tc<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', { select: ['id', 'title', 'active'] });
	for (const s of st?.stores ?? []) console.log(`    склад ${s['id']}: «${s['title']}» active=${s['active']}`);
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e));
