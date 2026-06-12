/**
 * РАЗВЕДКА (read-only): почему в нашей реализации клиент = «CONTACT_16332», а в нативной — имя.
 * Сравниваем наш заказ (сделка 36766, тест Сергея) с нативным заказом (старая реализация):
 * userId, профиль покупателя, propertyvalues.
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const execFileP = promisify(execFile);
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
if (!WEBHOOK) { console.error('DEV_WEBHOOK нет'); process.exit(1); }

async function b24<T>(method: string, params: Record<string, unknown>): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= 4; a++) {
		try {
			const { stdout } = await execFileP('curl.exe', [
				'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
				'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
			], { maxBuffer: 32 * 1024 * 1024 });
			const json = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
			if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
			return json.result as T;
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, a * 700)); }
	}
	throw last;
}

const pick = (o: Record<string, unknown> | undefined, keys: string[]) =>
	Object.fromEntries(keys.map((k) => [k, o?.[k]]));

async function dumpOrder(orderId: number, label: string): Promise<void> {
	console.log(`\n===== ${label}: заказ ${orderId} =====`);
	const o = await b24<{ order?: Record<string, unknown> }>('sale.order.get', { id: orderId });
	const ord = o?.order ?? {};
	console.log('order:', JSON.stringify(pick(ord, ['id', 'accountNumber', 'userId', 'personTypeId', 'price', 'currency', 'dateInsert', 'createdBy', 'responsibleId', 'userDescription', 'comments'])));
	// свойства заказа (Имя/Телефон/...)
	const pv = await b24<{ propertyValues?: Array<Record<string, unknown>> }>('sale.propertyvalue.list', { filter: { orderId } });
	for (const p of pv?.propertyValues ?? []) {
		console.log(`  prop ${p['orderPropsId']} «${p['name']}» = ${JSON.stringify(p['value'])}`);
	}
	// покупатель: user.get по userId (может не отдать не-интранет юзера)
	const userId = Number(ord['userId'] ?? 0);
	if (userId) {
		try {
			const users = await b24<Array<Record<string, unknown>>>('user.get', { ID: userId, ADMIN_MODE: 'Y' } as never);
			const u = Array.isArray(users) ? users[0] : undefined;
			console.log('  buyer user.get:', u ? JSON.stringify(pick(u, ['ID', 'NAME', 'LAST_NAME', 'EMAIL', 'XML_ID', 'ACTIVE', 'EXTERNAL_AUTH_ID'])) : 'НЕ НАЙДЕН user.get-ом');
		} catch (e) { console.log('  buyer user.get: ошибка', String(e).slice(0, 120)); }
	}
	// привязка к CRM
	try {
		const oe = await b24<unknown>('crm.orderentity.list', { filter: { orderId }, select: ['*'] });
		console.log('  orderentity:', JSON.stringify(oe).slice(0, 200));
	} catch (e) { console.log('  orderentity: ошибка', String(e).slice(0, 100)); }
}

async function main(): Promise<void> {
	// наш свежий заказ — по сделке 36766
	const oe = await b24<unknown>('crm.orderentity.list', { filter: { ownerId: 36766, ownerTypeId: 2 }, select: ['*'] });
	console.log('orderentity сделки 36766:', JSON.stringify(oe).slice(0, 300));
	const list = (Array.isArray(oe) ? oe : (oe as { orderEntity?: unknown[] })?.orderEntity ?? []) as Array<Record<string, unknown>>;
	const ourOrderId = Number(list[0]?.['orderId'] ?? 0);
	if (ourOrderId) await dumpOrder(ourOrderId, 'НАШ (сделка 36766)');
	else console.log('заказ по сделке 36766 не найден — скажи номер реализации');

	// нативный образец: заказ 860 (реализация #868, связка 860→32602 из прошлых разведок)
	await dumpOrder(860, 'НАТИВНЫЙ (образец)');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
