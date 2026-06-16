/**
 * Точечная проверка остатков товара в Б24 по всем складам (catalog.storeproduct.list).
 * Запуск: npx tsx recon-stock-check.ts "часть названия"
 */
import 'dotenv/config';
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
const NAME = process.argv[2] ?? 'Монитор AHD видеодомофона 7';

async function call(method: string, params: Record<string, unknown>): Promise<any> {
	const r = await fetch(`${WEBHOOK}/${method}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
	const j = (await r.json()) as { result?: any; error?: string; error_description?: string };
	if (j.error) throw new Error(`${j.error}: ${j.error_description ?? ''}`);
	return j.result;
}

(async () => {
	const st = await call('catalog.store.list', { select: ['id', 'title', 'active'] });
	const smap = new Map<number, { title: string; active: string }>((st.stores ?? []).map((s: any) => [Number(s.id), { title: String(s.title), active: String(s.active) }]));
	console.log(`складов в Б24: ${smap.size}`);

	const prods: any[] = [];
	for (const iblockId of [24, 26]) {
		const r = await call('catalog.product.list', { filter: { iblockId, '%name': NAME }, select: ['id', 'iblockId', 'name'] });
		prods.push(...(r.products ?? []));
	}
	if (!prods.length) { console.log(`товар «${NAME}» не найден`); return; }

	for (const p of prods) {
		console.log(`\n# ${p.name} (id ${p.id}, iblock ${p.iblockId})`);
		const sp = await call('catalog.storeproduct.list', { filter: { productId: Number(p.id) }, select: ['storeId', 'amount', 'quantityReserved'] });
		const rows = sp.storeProducts ?? [];
		if (!rows.length) { console.log('  catalog.storeproduct: ПУСТО (нет ни одной записи по складам)'); continue; }
		let total = 0;
		for (const r of rows) {
			const s = smap.get(Number(r.storeId));
			const amt = Number(r.amount ?? 0);
			total += amt;
			console.log(`  склад ${r.storeId} «${s?.title ?? '??? НЕТ В catalog.store.list'}» active=${s?.active ?? '?'}: amount=${amt} reserved=${r.quantityReserved ?? 0}`);
		}
		console.log(`  ИТОГО по складам: ${total}`);
	}
})().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(1); });
