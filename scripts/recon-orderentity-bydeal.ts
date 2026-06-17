/**
 * Read-only: умеет ли crm.orderentity.list фильтр по ownerId (сделке)?
 * Нужно для «переиспользуем заказ сделки» в партиях реализации.
 * Запуск: npx tsx scripts/recon-orderentity-bydeal.ts
 */
import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function tc<T>(m: string, p: Record<string, unknown>): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= 6; a++) {
		try { return await c.call<T>(m, p); }
		catch (e) { last = e; await wait(a * 1000); }
	}
	throw last;
}
(async () => {
	const r = await tc('crm.orderentity.list', { filter: { ownerId: 36754, ownerTypeId: 2 }, select: ['*'] });
	console.log('тест-сделка 36754:', JSON.stringify(r));
	const r2 = await tc('crm.orderentity.list', { filter: { ownerId: 36512, ownerTypeId: 2 }, select: ['*'] });
	console.log('нативная 36512:', JSON.stringify(r2));
	const r3 = await tc('crm.orderentity.list', { filter: { ownerId: 99999999, ownerTypeId: 2 }, select: ['*'] });
	console.log('несуществующая:', JSON.stringify(r3));
})().catch((e) => console.error('FAIL', String(e)));
