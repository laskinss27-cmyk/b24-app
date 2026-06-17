/**
 * Read-only: кандидаты в дубли каталога — товары, чьи названия совпадают как МНОЖЕСТВО СЛОВ
 * (перестановки: «IP камеры» = «камеры IP»). Данные из локального ERPNext (сеть не нужна).
 * Запуск: npx tsx scripts/erp-dupes-report.ts
 */
const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? 'token REDACTED';

async function list(doctype: string, fields: string[], filters?: unknown[]): Promise<any[]> {
	const q = new URLSearchParams({ fields: JSON.stringify(fields), limit_page_length: '0' });
	if (filters) q.set('filters', JSON.stringify(filters));
	const res = await fetch(`${ERP}/api/resource/${encodeURIComponent(doctype)}?${q}`, { headers: { Authorization: ERP_AUTH } });
	const j = (await res.json()) as { data?: any[] };
	return j.data ?? [];
}

const norm = (s: string): string[] =>
	s.toLowerCase()
		.replace(/ё/g, 'е')
		.replace(/[^\p{L}\p{N}.]+/gu, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.sort();

(async () => {
	const items = await list('Item', ['name', 'item_name'], [['item_group', '=', 'Каталог Б24']]);
	console.log(`товаров: ${items.length}`);

	// 1) Точные дубли-перестановки: одинаковое множество слов
	const groups = new Map<string, Array<{ code: string; name: string }>>();
	for (const it of items) {
		const key = norm(String(it.item_name)).join(' ');
		if (!key) continue;
		const g = groups.get(key) ?? [];
		g.push({ code: String(it.name), name: String(it.item_name) });
		groups.set(key, g);
	}
	const dupes = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
	console.log(`\n=== СТРОГИЕ ДУБЛИ (одни и те же слова, любой порядок): групп ${dupes.length}, карточек ${dupes.reduce((a, g) => a + g.length, 0)} ===`);
	for (const g of dupes.slice(0, 25)) {
		console.log(`  × ${g.length}:`);
		for (const it of g) console.log(`     [${it.code}] «${it.name.slice(0, 70)}»`);
	}

	// 2) Подозрительные: совпадают «значимые» токены (выкинув родовые слова)
	const STOP = new Set(['ip', 'камера', 'камеры', 'видеокамера', 'уличная', 'уличные', 'купольная', 'для', 'с', 'и', 'на', 'в']);
	const sig = new Map<string, Array<{ code: string; name: string }>>();
	for (const it of items) {
		const tokens = norm(String(it.item_name)).filter((t) => !STOP.has(t));
		const key = tokens.join(' ');
		if (tokens.length < 2) continue;
		const g = sig.get(key) ?? [];
		g.push({ code: String(it.name), name: String(it.item_name) });
		sig.set(key, g);
	}
	const fuzzy = [...sig.values()].filter((g) => g.length > 1 && new Set(g.map((x) => norm(x.name).join(' '))).size > 1).sort((a, b) => b.length - a.length);
	console.log(`\n=== ПОДОЗРИТЕЛЬНЫЕ (совпадают модель/артикул, разнятся родовые слова): групп ${fuzzy.length} ===`);
	for (const g of fuzzy.slice(0, 15)) {
		console.log(`  × ${g.length}:`);
		for (const it of g) console.log(`     [${it.code}] «${it.name.slice(0, 70)}»`);
	}

	console.log('\nГОТОВО (read-only, локальный ERPNext)');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
