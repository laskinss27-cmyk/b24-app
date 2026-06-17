/**
 * Read-only: товарная часть и поля карточки «Снабжение» (1110).
 *  1) crm.item.fields 1110 — подписи всех uf-полей (ищем «Склад поставки», «Дата поставки»)
 *  2) есть ли у карточек товарные строки: crm.item.productrow.list с ownerType-кандидатами
 *     (динамические сущности: 'T' + hex(entityTypeId): 1110 → 'T456'; пробуем варианты)
 * Запуск: npx tsx scripts/recon-supply-rows.ts
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
	console.log('=== 1) Поля карточки «Снабжение» (crm.item.fields 1110) ===');
	const f = await tc<{ fields?: Record<string, Record<string, unknown>> }>('crm.item.fields', { entityTypeId: 1110 });
	for (const [code, def] of Object.entries(f?.fields ?? {})) {
		const title = String(def['title'] ?? '');
		const upper = String(def['upperName'] ?? '');
		if (/^ufCrm/i.test(code) || /склад|дата|постав|товар/i.test(title)) {
			console.log(`  ${code} [${def['type']}] — «${title}»${upper && upper !== code ? '' : ''}`);
			const items = (def['items'] as Array<{ ID: string; VALUE: string }>) ?? [];
			for (const it of items.slice(0, 8)) console.log(`     enum ${it.ID} = «${it.VALUE}»`);
		}
	}

	console.log('\n=== 2) Товарные строки карточек (ownerType-кандидаты) ===');
	for (const cardId of [176, 170, 150]) {
		for (const ot of ['T456', 'Tb6', 'DYNAMIC_1110', '1110']) {
			const r = await tc<{ productRows?: Array<Record<string, unknown>> }>('crm.item.productrow.list', {
				filter: { '=ownerType': ot, ownerId: cardId },
			});
			if (r) {
				const rows = r.productRows ?? [];
				console.log(`  карточка ${cardId} ownerType=${ot}: строк ${rows.length}`);
				for (const row of rows.slice(0, 6)) console.log(`    «${String(row['productName']).slice(0, 45)}» qty=${row['quantity']} price=${row['price']} type=${row['type']}`);
				break;
			}
		}
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e));
