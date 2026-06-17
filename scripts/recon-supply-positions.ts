/**
 * Read-only: «Товарная позиция» (1114) — структура дочерних позиций заявки снабжения,
 * и справочник «Склад поставки» (iblock_element поля ufCrm38_1778141770).
 * Запуск: npx tsx scripts/recon-supply-positions.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let a = 1; a <= 5; a++) {
		try { return await c.call<T>(m, p); }
		catch (e) {
			if (e instanceof B24ApiError) { console.log(`  ⛔ ${m} → ${e.code}:${(e.description ?? '').slice(0, 110)}`); return null; }
			if (a === 5) { console.log(`  ⛔ ${m} → ${String(e)}`); return null; }
			await wait(a * 800);
		}
	}
	return null;
}
const short = (v: unknown, n = 160): string => { const s = JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };

(async () => {
	console.log('=== 1) Поля «Товарной позиции» (crm.item.fields 1114) — с настройками ===');
	const f = await tc<{ fields?: Record<string, Record<string, unknown>> }>('crm.item.fields', { entityTypeId: 1114 });
	for (const [code, def] of Object.entries(f?.fields ?? {})) {
		if (/^ufCrm|^parentId|^title$|^assignedById$|^stageId$/i.test(code)) {
			console.log(`  ${code} [${def['type']}] — «${def['title']}» settings=${short(def['settings'], 120)}`);
			const items = (def['items'] as Array<{ ID: string; VALUE: string }>) ?? [];
			for (const it of items.slice(0, 6)) console.log(`     enum ${it.ID} = «${it.VALUE}»`);
		}
	}

	console.log('\n=== 2) Живая товарная позиция 1072 (из заявки 150) ===');
	const it = await tc<{ item?: Record<string, unknown> }>('crm.item.get', { entityTypeId: 1114, id: 1072 });
	for (const [k, v] of Object.entries(it?.item ?? {})) {
		if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
		console.log(`  ${k} = ${short(v)}`);
	}

	console.log('\n=== 3) Настройки поля «Склад поставки» у Снабжения (какой iblock) ===');
	const f1110 = await tc<{ fields?: Record<string, Record<string, unknown>> }>('crm.item.fields', { entityTypeId: 1110 });
	const sklad = f1110?.fields?.['ufCrm38_1778141770'];
	console.log('  ufCrm38_1778141770 settings =', short(sklad?.['settings'], 400));

	console.log('\n=== 4) Свежие позиции 1114 списком (паттерн заголовков/полей) ===');
	const list = await tc<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
		entityTypeId: 1114, order: { id: 'desc' }, select: ['id', 'title', 'stageId', 'parentId1110', 'createdTime'],
	});
	for (const i of (list?.items ?? []).slice(0, 8)) console.log(`  [${i['id']}] «${String(i['title']).slice(0, 55)}» заявка=${i['parentId1110']} stage=${i['stageId']}`);

	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e));
