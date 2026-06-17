/**
 * Read-only: когда у заявки Снабжения появляются «Товарные позиции» (1114)?
 * Сравниваем заявки на разных стадиях: 162 (NEW), 170 (в работе), 176/168 (SUCCESS).
 * Поля заявки: «Позиции созданы?» (ufCrm38_1778141328: 976 Да / 978 Нет), стадия, создатель позиций.
 * Запуск: npx tsx scripts/recon-supply-who-creates.ts
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

(async () => {
	for (const id of [178, 176, 170, 168, 162, 150]) {
		const card = await tc<{ item?: Record<string, unknown> }>('crm.item.get', { entityTypeId: 1110, id });
		const i = card?.item;
		if (!i) continue;
		console.log(`\nзаявка ${id} «${String(i['title']).slice(0, 40)}» stage=${i['stageId']} created=${i['createdTime']} by=${i['createdBy']}`);
		console.log(`  ПозицииСозданы=${i['ufCrm38_1778141328']} (976=Да/978=Нет) | СкладПоставки=${i['ufCrm38_1778141770']} | ДатаПоставки=${i['ufCrm38_1777817961']}`);
		const pos = await tc<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
			entityTypeId: 1114,
			filter: { parentId1110: id },
			select: ['id', 'title', 'createdBy', 'createdTime', 'ufCrm40_1779719295', 'ufCrm40_1777821192'],
		});
		for (const p of pos?.items ?? []) {
			console.log(`    позиция [${p['id']}] «${String(p['title']).slice(0, 50)}» тип=${p['ufCrm40_1779719295']} qty=${p['ufCrm40_1777821192']} created=${p['createdTime']} by=${p['createdBy']}`);
		}
		if (!(pos?.items ?? []).length) console.log('    (позиций нет)');
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e));
