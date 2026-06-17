/**
 * Read-only разведка: КАК на портале устроена реализация (отгрузка товара со склада),
 * чтобы понять, каким документом/методом её создавать в нашей вкладке сделки.
 * Бьём DEV_WEBHOOK, НИЧЕГО не пишем.
 *
 * Вопросы:
 *   1) Какие docType у складских документов реально есть (catalog.document.list) и сколько.
 *   2) Как выглядит документ каждого типа (поля), есть ли привязка к сделке (поле/commentary).
 *   3) Есть ли отдельный тип «Реализация» (продажа) vs «Списание».
 *   4) Поля строки документа (catalog.document.element.list) — storeFrom/storeTo/amount.
 *   5) Связь сделка→документы: ищем по commentary «Сделка»/dealId.
 *
 * Запуск: npx tsx scripts/recon-realization.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK не задан'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function hr(t: string): void { console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`); }
function j(label: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2500) s = s.slice(0, 2500) + '…'; console.log(`${label}: ${s}`); }
async function tryCall<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}

async function main(): Promise<void> {
	hr('1) СКЛАДСКИЕ ДОКУМЕНТЫ — все docType (catalog.document.list, страницами)');
	const docs: Array<Record<string, unknown>> = [];
	let start = 0;
	for (let i = 0; i < 30; i++) {
		const page = await tryCall<{ documents?: Array<Record<string, unknown>> }>('catalog.document.list', { select: ['id', 'docType', 'status', 'title', 'dateCreate', 'dateModify'], order: { id: 'DESC' }, start });
		const arr = page?.documents ?? [];
		docs.push(...arr);
		if (arr.length < 50) break;
		start += 50;
	}
	console.log(`всего документов: ${docs.length}`);
	const byType = new Map<string, number>();
	for (const d of docs) { const t = String(d['docType'] ?? '?'); byType.set(t, (byType.get(t) ?? 0) + 1); }
	j('docType → количество', Object.fromEntries(byType));
	console.log('  (Б24 docType: A=Оприходование, S=?, M=Перемещение, R=Возврат, D=Списание, W=… — уточняем по факту)');

	hr('2) ПРИМЕР ДОКУМЕНТА КАЖДОГО ТИПА (все поля — ищем привязку к сделке)');
	const seen = new Set<string>();
	for (const d of docs) {
		const t = String(d['docType'] ?? '?');
		if (seen.has(t)) continue;
		seen.add(t);
		const full = await tryCall<{ document?: Record<string, unknown> }>('catalog.document.get', { id: Number(d['id']) });
		console.log(`\n  --- docType=${t} (id=${d['id']}, title="${String(d['title'] ?? '')}") ---`);
		j('  поля', full?.document ?? d);
	}

	hr('3) ПОЛЯ строки документа (catalog.document.element.list по последнему документу)');
	if (docs[0]) {
		const els = await tryCall<{ documentElements?: Array<Record<string, unknown>> }>('catalog.document.element.list', { filter: { docId: Number(docs[0]['id']) } });
		j('первая строка', (els?.documentElements ?? [])[0] ?? '(пусто)');
	}

	hr('4) Поиск привязки к сделке: документы с commentary, содержащим «Сделка»/«сделк»');
	const withComment = docs.filter((d) => /сделк/i.test(String(d['commentary'] ?? d['title'] ?? '')));
	console.log(`документов с упоминанием сделки в title/commentary: ${withComment.length} (выборка по title; точнее — в полном документе поле commentary)`);

	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
