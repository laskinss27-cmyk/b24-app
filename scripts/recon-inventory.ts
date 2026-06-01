/**
 * Read-only разведка под инвентаризацию. Ничего не пишем.
 * Цель — понять точку интеграции:
 *   1) какие scope есть у токена (нужен ли task, entity/highloadblock для хранилища)
 *   2) как выглядит автозадача инвентаризации (задача 7018, которую дал Сергей)
 *   3) как опознавать инвентаризационные задачи (паттерн по списку)
 *   4) текущие placement-привязки (+ можно ли встроить кнопку в задачу)
 *   5) что доступно под хранилище черновика (entity / highloadblock)
 *
 * npx tsx scripts/recon-inventory.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function hr(t: string): void {
	console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
}
function j(label: string, data: unknown): void {
	let s = JSON.stringify(data, null, 2);
	if (s && s.length > 4000) s = s.slice(0, 4000) + `\n…(обрезано, всего ${s.length})`;
	console.log(`${label}:\n${s}`);
}
async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		if (err instanceof B24ApiError) console.log(`  ⛔ ${method} → ${err.code}: ${err.description ?? ''}`);
		else console.log(`  ⛔ ${method} → ${String(err)}`);
		return null;
	}
}

async function main(): Promise<void> {
	hr('1. SCOPE токена (что вообще доступно)');
	j('scope', await tryCall('scope', {}));

	hr('2. ЗАДАЧА 7018 (tasks.task.get) — как выглядит автозадача инвентаризации');
	const task = await tryCall<{ task?: Record<string, unknown> }>('tasks.task.get', { taskId: 7018 });
	const t = task?.task ?? null;
	if (t) {
		// крупное (описание) отдельно, остальное компактно
		const { DESCRIPTION, ...rest } = t as Record<string, unknown>;
		j('task (без DESCRIPTION)', rest);
		console.log(`\nDESCRIPTION:\n${String(DESCRIPTION ?? '').slice(0, 2000)}`);
		// какие UF_* заполнены
		const uf: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(t)) if (k.startsWith('UF_') && v != null && v !== '' && JSON.stringify(v) !== '[]') uf[k] = v;
		j('заполненные UF_*', uf);
	} else {
		console.log('задача не пришла (нет scope task? или нет доступа)');
	}

	hr('3. ПОХОЖИЕ ЗАДАЧИ (tasks.task.list, TITLE ~ «инвентар») — паттерн опознавания');
	const list = await tryCall<{ tasks?: Array<Record<string, unknown>> }>('tasks.task.list', {
		filter: { '%TITLE': 'нвентар' },
		select: ['ID', 'TITLE', 'CREATED_BY', 'RESPONSIBLE_ID', 'GROUP_ID', 'STATUS'],
		order: { ID: 'DESC' },
	});
	j('инвентаризационные задачи (топ)', (list?.tasks ?? []).slice(0, 10));

	hr('4. PLACEMENT.LIST (текущие привязки)');
	j('placements', await tryCall('placement.list', {}));

	hr('5. ХРАНИЛИЩЕ под черновик отчёта (read-only probe)');
	j('entity.get', await tryCall('entity.get', {}));
	j('highloadblock.highloadblock.list', await tryCall('highloadblock.highloadblock.list', {}));
	j('lists.get (iblock-списки)', await tryCall('lists.get', { IBLOCK_TYPE_ID: 'lists' }));

	hr('ГОТОВО — ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
