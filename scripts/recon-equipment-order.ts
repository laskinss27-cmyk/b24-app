/**
 * Read-only: поле сделки «Требуется ли заказ оборудования» (да/нет) — что оно делает?
 * Гипотеза Сергея: при «Да» рождается задача на снабжение с номером сделки и перечнем.
 * Владимир в отпуске — спрашиваем сам портал:
 *  1) crm.deal.fields — ищем UF-поле про заказ/оборудование/снабжение (+ его enum-значения)
 *  2) свежие сделки, где оно заполнено
 *  3) задачи, привязанные к этим сделкам (UF_CRM_TASK=D_<id>) — есть ли паттерн «снабжение»
 * Запуск: npx tsx scripts/recon-equipment-order.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let a = 1; a <= 5; a++) {
		try { return await c.call<T>(m, p); }
		catch (e) {
			if (e instanceof B24ApiError) { console.log(`  ⛔ ${m} → ${e.code}:${e.description ?? ''}`); return null; }
			if (a === 5) { console.log(`  ⛔ ${m} → ${String(e)}`); return null; }
			await wait(a * 800);
		}
	}
	return null;
}

(async () => {
	console.log('=== 1) UF-поля сделки про заказ/оборудование/снабжение ===');
	const fields = await tc<Record<string, Record<string, unknown>>>('crm.deal.fields', {});
	const hits: Array<{ code: string; def: Record<string, unknown> }> = [];
	for (const [code, def] of Object.entries(fields ?? {})) {
		const label = String(def['formLabel'] ?? def['listLabel'] ?? def['title'] ?? '');
		if (/заказ|оборудован|снабж|закуп|постав/i.test(label) || (/заказ|оборудован|снабж|закуп/i.test(code))) {
			hits.push({ code, def });
			console.log(`  ${code} [${def['type']}] — «${label}»`);
			const items = def['items'] as Array<{ ID: string; VALUE: string }> | undefined;
			if (items) for (const it of items) console.log(`     enum ${it.ID} = «${it.VALUE}»`);
		}
	}
	if (!hits.length) { console.log('  (по маске ничего — выведу ВСЕ UF_ с подписями)'); for (const [code, def] of Object.entries(fields ?? {})) if (code.startsWith('UF_')) console.log(`  ${code} [${def['type']}] — «${String(def['formLabel'] ?? def['listLabel'] ?? '')}»`); }

	// кандидаты с enum да/нет или boolean
	for (const h of hits) {
		const type = String(h.def['type']);
		if (!/enumeration|boolean/.test(type)) continue;
		console.log(`\n=== 2) Свежие сделки, где ${h.code} заполнено ===`);
		const deals = await tc<Array<Record<string, unknown>>>('crm.deal.list', {
			filter: { [`!${h.code}`]: false },
			select: ['ID', 'TITLE', h.code, 'DATE_CREATE'],
			order: { ID: 'DESC' },
		});
		const top = (deals ?? []).slice(0, 6);
		for (const d of top) console.log(`  сделка ${d['ID']} «${String(d['TITLE']).slice(0, 45)}» — ${h.code}=${JSON.stringify(d[h.code])} (${d['DATE_CREATE']})`);

		console.log(`\n=== 3) Задачи этих сделок (паттерн снабжения?) ===`);
		for (const d of top.slice(0, 4)) {
			const t = await tc<{ tasks?: Array<Record<string, unknown>> }>('tasks.task.list', {
				filter: { UF_CRM_TASK: `D_${d['ID']}` },
				select: ['ID', 'TITLE', 'CREATED_DATE', 'RESPONSIBLE_ID', 'CREATED_BY', 'DESCRIPTION'],
			});
			console.log(`  сделка ${d['ID']}: задач ${(t?.tasks ?? []).length}`);
			for (const task of (t?.tasks ?? []).slice(0, 5)) {
				console.log(`    [${task['id'] ?? task['ID']}] «${String(task['title'] ?? task['TITLE']).slice(0, 60)}» отв=${JSON.stringify((task['responsible'] as Record<string, unknown>)?.['name'] ?? task['responsibleId'] ?? task['RESPONSIBLE_ID'])} created=${task['createdDate'] ?? task['CREATED_DATE']}`);
				const desc = String(task['description'] ?? task['DESCRIPTION'] ?? '').replace(/\s+/g, ' ').slice(0, 180);
				if (desc) console.log(`        описание: ${desc}`);
			}
		}
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e instanceof B24ApiError ? `${e.code}:${e.description ?? ''}` : e));
