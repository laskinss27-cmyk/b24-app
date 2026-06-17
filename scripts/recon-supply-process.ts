/**
 * Read-only: смарт-процесс снабжения (entityTypeId 1038?) — что рождается при «Требуется заказ
 * оборудования = Да». Смотрим карточки, их поля (перечень оборудования?), ответственных, стадии.
 * Запуск: npx tsx scripts/recon-supply-process.ts
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
const short = (v: unknown, n = 120): string => { const s = JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };

(async () => {
	console.log('=== 1) Смарт-процессы портала (crm.type.list) ===');
	const types = await tc<{ types?: Array<Record<string, unknown>> }>('crm.type.list', {});
	for (const t of types?.types ?? []) console.log(`  entityTypeId=${t['entityTypeId']} «${t['title']}» (id=${t['id']})`);

	console.log('\n=== 2) Сделки с «Да» — их PARENT_ID_1038 и ID карточки снабжения ===');
	const deals = await tc<Array<Record<string, unknown>>>('crm.deal.list', {
		filter: { UF_CRM_1750389326: '86' },
		select: ['ID', 'TITLE', 'PARENT_ID_1038', 'UF_CRM_1777817683', 'UF_CRM_1781080139', 'DATE_CREATE'],
		order: { ID: 'DESC' },
	});
	const cardIds: number[] = [];
	for (const d of (deals ?? []).slice(0, 8)) {
		console.log(`  сделка ${d['ID']} «${String(d['TITLE']).slice(0, 40)}»: PARENT_ID_1038=${short(d['PARENT_ID_1038'])} заявка_создана=${short(d['UF_CRM_1777817683'])} id_карточки=${short(d['UF_CRM_1781080139'])}`);
		const pid = Number(d['PARENT_ID_1038'] ?? 0);
		if (pid > 0) cardIds.push(pid);
		const m = /(\d+)/.exec(String(d['UF_CRM_1781080139'] ?? ''));
		if (m) cardIds.push(Number(m[1]));
	}

	console.log('\n=== 3) Карточки снабжения (crm.item.get entityTypeId=1038) ===');
	for (const id of [...new Set(cardIds)].slice(0, 4)) {
		const it = await tc<{ item?: Record<string, unknown> }>('crm.item.get', { entityTypeId: 1038, id });
		const item = it?.item;
		if (!item) continue;
		console.log(`\n  карточка ${id}: «${item['title']}» stage=${item['stageId']} assigned=${item['assignedById']} created=${item['createdTime']}`);
		for (const [k, v] of Object.entries(item)) {
			if (/^(uf|parentId)/i.test(k) && v != null && v !== '' && !(Array.isArray(v) && !v.length)) console.log(`    ${k} = ${short(v, 220)}`);
		}
	}

	console.log('\n=== 4) Последние карточки 1038 списком (как выглядят свежие) ===');
	const list = await tc<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
		entityTypeId: 1038, order: { id: 'desc' }, select: ['id', 'title', 'stageId', 'assignedById', 'parentId2', 'createdTime'],
	});
	for (const i of (list?.items ?? []).slice(0, 8)) console.log(`  [${i['id']}] «${String(i['title']).slice(0, 50)}» stage=${i['stageId']} deal(parentId2)=${i['parentId2']} assigned=${i['assignedById']}`);

	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e instanceof B24ApiError ? `${e.code}:${e.description ?? ''}` : e));
