/**
 * Read-only: структура специфичной задачи 7778 (осмотр объекта) — что складу заполнять при создании.
 * Запуск: npx tsx scripts/recon-task-7778.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 3500) s = s.slice(0, 3500) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	console.log('=== задача 7778 — ключевые + UF поля ===');
	const t = await tc<{ task?: Record<string, unknown> }>('tasks.task.get', { taskId: 7778, select: ['*', 'UF_*'] });
	const task = t?.task ?? {};
	const want = ['id', 'title', 'description', 'responsibleId', 'createdBy', 'groupId', 'deadline', 'priority', 'tags', 'parentId', 'stageId', 'flowId', 'ufCrmTask'];
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(task)) {
		if (want.includes(k) || /uf|crm|tag|group|flow|stage|template|epic|scrum/i.test(k)) {
			const v = task[k];
			if (v !== null && v !== '' && v !== '0' && v !== 0 && !(Array.isArray(v) && !v.length)) out[k] = v;
		}
	}
	j('ключевые поля', out);
	console.log('ВСЕ ключи задачи:', Object.keys(task).join(', '));

	console.log('\n=== названия UF-полей задач (что значат UF_*) ===');
	const f = await tc<Record<string, { title?: string; type?: string }>>('tasks.task.getFields', {});
	if (f) {
		const uf = Object.entries(f).filter(([k]) => k.startsWith('UF_'));
		for (const [k, v] of uf) console.log(`  ${k} | ${v?.type ?? ''} | ${v?.title ?? ''}`);
	}

	console.log('\n=== чек-лист задачи 7778 ===');
	const cl = await tc<Array<Record<string, unknown>>>('task.checklistitem.getlist', { taskId: 7778 });
	if (Array.isArray(cl)) for (const i of cl.slice(0, 20)) console.log(`  [${i['IS_COMPLETE'] === 'Y' ? 'x' : ' '}] ${i['TITLE']}`);
	else j('checklist', cl);
})().catch((e) => console.error('FATAL', e));
