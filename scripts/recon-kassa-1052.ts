/**
 * Read-only: смарт-процесс «Кассы» (entityTypeId 1052) — можно ли создавать оплату через REST?
 * Читаем поля типа + сам документ 906 (пример оплаты от Сергея).
 * Запуск: npx tsx scripts/recon-kassa-1052.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 3000) s = s.slice(0, 3000) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	console.log('=== поля типа 1052 (Кассы) — что можно писать ===');
	const f = await tc<{ fields?: Record<string, Record<string, unknown>> }>('crm.item.fields', { entityTypeId: 1052 });
	const fields = f?.fields ?? {};
	for (const [k, v] of Object.entries(fields)) {
		const t = (v as Record<string, unknown>)['type'];
		const title = (v as Record<string, unknown>)['title'];
		console.log(`  ${k} | ${t} | ${title}`);
	}

	console.log('\n=== документ 906 (пример оплаты) — реальные значения ===');
	const item = await tc<{ item?: Record<string, unknown> }>('crm.item.get', { entityTypeId: 1052, id: 906 });
	const it = item?.item ?? {};
	// показываем только заполненные поля (без пустых)
	const filled = Object.fromEntries(Object.entries(it).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
	j('заполненные поля 906', filled);

	console.log('\n=== можно ли создавать? проба crm.item.add без полей (ждём валидационную ошибку, не method_not_found) ===');
	await tc('crm.item.add', { entityTypeId: 1052 });
})().catch((e) => console.error('FATAL', e));
