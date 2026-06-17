/**
 * Read-only прогон РЕАЛЬНОЙ сборки Базы (buildProductBase) на боевых данных через
 * webhook-клиент. Меряем время (риск 30s-таймаута контейнера) и заполненность полей.
 * Ничего не пишем.
 *
 * npx tsx scripts/recon-baza-build.ts
 */
import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';
import { buildProductBase } from '../packages/backend/src/b24/catalog.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

async function main(): Promise<void> {
	const t0 = Date.now();
	const { rows } = await buildProductBase(client);
	const ms = Date.now() - t0;

	const withRetail = rows.filter((r) => r.retail != null).length;
	const withPurchase = rows.filter((r) => r.purchase != null).length;
	const withBrand = rows.filter((r) => r.manufacturer).length;
	const withModel = rows.filter((r) => r.model).length;
	const withSection = rows.filter((r) => r.sectionName).length;
	const withPhoto = rows.filter((r) => r.photoPath).length;
	const pct = (n: number): string => `${n} (${Math.round((n / rows.length) * 100)}%)`;

	console.log(`\n=== СБОРКА БАЗЫ за ${(ms / 1000).toFixed(1)}с ===`);
	console.log(`строк (товаров с остатком>0): ${rows.length}`);
	console.log(`  розница: ${pct(withRetail)}`);
	console.log(`  закупка: ${pct(withPurchase)}`);
	console.log(`  производитель: ${pct(withBrand)}`);
	console.log(`  модель: ${pct(withModel)}`);
	console.log(`  раздел: ${pct(withSection)}`);
	console.log(`  фото: ${pct(withPhoto)}`);

	console.log('\n=== первые 8 строк ===');
	for (const r of rows.slice(0, 8)) {
		const stores = Object.entries(r.stockByStore).map(([s, n]) => `${s}:${n}`).join(' ');
		console.log(`#${r.id} ib${r.iblockId} | ${r.name.slice(0, 42).padEnd(42)} | мод:${(r.model ?? '—').slice(0, 12).padEnd(12)} | бр:${(r.manufacturer ?? '—').slice(0, 10).padEnd(10)} | роз:${r.retail ?? '—'} зак:${r.purchase ?? '—'} | ост ${r.total} [${stores}]`);
	}
	console.log('\nГОТОВО — ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
