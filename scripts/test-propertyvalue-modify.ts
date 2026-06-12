/**
 * ЖИВОЙ ТЕСТ формата sale.propertyvalue.modify на ТЕСТОВОМ заказе 966 (сделка 36766,
 * тест Сергея — баг «клиент = CONTACT_16332»). Пишем prop 40 «Имя Фамилия» и читаем обратно.
 * Перебираем варианты формата, пока один не сработает; печатаем точные ошибки остальных.
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const execFileP = promisify(execFile);
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
const ORDER_ID = 966;
const NAME = 'Анна Кузнецова';

async function b24<T>(method: string, params: Record<string, unknown>): Promise<T> {
	const { stdout } = await execFileP('curl.exe', [
		'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
		'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
	], { maxBuffer: 16 * 1024 * 1024 });
	const json = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
	if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
	return json.result as T;
}

async function readProp40(): Promise<unknown> {
	const pv = await b24<{ propertyValues?: Array<Record<string, unknown>> }>('sale.propertyvalue.list', { filter: { orderId: ORDER_ID } });
	return (pv?.propertyValues ?? []).find((p) => Number(p['orderPropsId']) === 40);
}

async function tryVariant(label: string, params: Record<string, unknown>): Promise<boolean> {
	try {
		const r = await b24('sale.propertyvalue.modify', params);
		console.log(`✓ ${label}: вызов прошёл, ответ ${JSON.stringify(r).slice(0, 160)}`);
		const p40 = await readProp40();
		console.log(`  prop40 теперь: ${JSON.stringify(p40)}`);
		return Boolean(p40 && (p40 as Record<string, unknown>)['value'] === NAME);
	} catch (e) {
		console.log(`⛔ ${label}: ${String(e).slice(0, 220)}`);
		return false;
	}
}

async function main(): Promise<void> {
	console.log('prop40 до:', JSON.stringify(await readProp40()));

	// 1) как в нашем коде сейчас
	if (await tryVariant('V1 fields.order.propertyValues[{orderPropsId,value}]',
		{ fields: { order: { id: ORDER_ID, propertyValues: [{ orderPropsId: 40, value: NAME }] } } })) return done();

	// 2) то же без обёртки fields
	if (await tryVariant('V2 order.propertyValues (без fields)',
		{ order: { id: ORDER_ID, propertyValues: [{ orderPropsId: 40, value: NAME }] } })) return done();

	// 3) value массивом (мультиполя Б24 любят массивы)
	if (await tryVariant('V3 value массивом',
		{ fields: { order: { id: ORDER_ID, propertyValues: [{ orderPropsId: 40, value: [NAME] }] } } })) return done();

	console.log('\nни один вариант не записал prop40 — копаем дальше (sale.order.update properties?)');
}
function done(): void { console.log('\n✅ РАБОЧИЙ ФОРМАТ НАЙДЕН (см. последний ✓)'); }

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
