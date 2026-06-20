/**
 * ПРОБА Б24-обвязки перемещения против trial-портала (НЕ прод).
 * Делает то же, что эндпоинт /api/transfers/create: ensure хранилища → документ → задача → чтение назад.
 * Запуск:  DEV_WEBHOOK=<trial-webhook> npx tsx scripts/test-transfer-glue.ts
 * Созданные сущности НЕ удаляет — печатает их ID (чистит Сергей).
 */
import 'dotenv/config';
import { request } from 'undici';

const WH = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
if (!WH) { console.error('нет DEV_WEBHOOK'); process.exit(1); }

async function b24<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	const res = await request(`${WH}/${method}.json`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify(params), headersTimeout: 30000, bodyTimeout: 30000,
	});
	const j = (await res.body.json()) as { result?: T; error?: string; error_description?: string };
	if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description ?? ''}`);
	return j.result as T;
}

const ENTITY = 'ctv_transfers';

async function main(): Promise<void> {
	console.log('портал:', WH.split('/rest')[0]);

	try { await b24('entity.add', { ENTITY, NAME: 'CTV Перемещения (складской учёт)', ACCESS: { AU: 'W' } }); console.log('✅ entity.add — хранилище создано'); }
	catch (e) { if (/exist/i.test(String(e))) console.log('= хранилище уже есть'); else throw e; }

	const me = await b24<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current');
	console.log('я:', me.ID, me.NAME, me.LAST_NAME);

	let head = 0;
	try {
		const d = await b24<Array<{ UF_HEAD?: unknown }>>('department.get', { ID: 10 });
		head = Number((Array.isArray(d) ? d[0] : undefined)?.UF_HEAD ?? 0) || 0;
	} catch { /* нет отдела 10 на триале — норм */ }
	console.log('глава отдела «Снабжение» (10):', head || '(нет — фолбэк на инициатора)');

	const data = {
		dealId: '32592', toStore: 'Максидом Дунайский 64', fromStore: 'Измайловский 18Д',
		status: 'requested',
		lines: [{ productId: 101, name: 'IP-камера AHD 2 Мп', qty: 5 }],
		createdAt: new Date().toISOString(), createdById: String(me.ID), createdByName: `${me.NAME} ${me.LAST_NAME}`,
	};
	const itemName = `Перемещение #${data.dealId}: ${data.fromStore} → ${data.toStore}`;
	const added = await b24<number | { id?: number }>('entity.item.add', { ENTITY, NAME: itemName, DETAIL_TEXT: JSON.stringify(data) });
	const itemId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
	if (!itemId) throw new Error('entity.item.add не вернул id');
	console.log('✅ документ перемещения создан, ID:', itemId);

	const responsible = head || Number(me.ID);
	const task = await b24<{ task?: { id?: number | string } }>('tasks.task.add', {
		fields: {
			TITLE: `[ТЕСТ] Перемещение: ${data.fromStore} → ${data.toStore} (сделка #${data.dealId})`,
			DESCRIPTION: `Тестовая задача из песочницы. Запрос на перемещение со склада «${data.fromStore}» на «${data.toStore}».`,
			RESPONSIBLE_ID: responsible,
		},
	});
	const taskId = Number(task?.task?.id ?? 0) || 0;
	console.log('✅ задача создана, ID:', taskId);

	const items = await b24<Array<Record<string, unknown>>>('entity.item.get', { ENTITY, FILTER: { ID: itemId } });
	const back = (items ?? [])[0];
	console.log('✅ документ читается обратно:', back ? String(back['NAME']) : 'НЕ НАЙДЕН');

	console.log('\n— созданные тестовые сущности (почистишь сам, если надо):');
	console.log(`   entity «${ENTITY}» item ID=${itemId}`);
	console.log(`   task ID=${taskId}`);
}
main().catch((e) => { console.error('FATAL:', String(e).slice(0, 300)); process.exit(1); });
