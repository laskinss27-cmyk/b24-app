/**
 * Read-only разведка API складских документов Б24 — под фазу C (списание/оприходование).
 * Узнаём: типы документов, поля документа и строки, структуру существующих
 * списаний/оприходований, статусы (черновик N / проведён Y). НИЧЕГО не создаём и не проводим.
 *
 * npx tsx scripts/recon-documents.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан в .env');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function hr(t: string): void {
	console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
}
function j(label: string, data: unknown): void {
	let s = JSON.stringify(data, null, 2);
	if (s && s.length > 4500) s = s.slice(0, 4500) + `\n…(обрезано, всего ${s.length})`;
	console.log(`${label}:\n${s}`);
}
async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		console.log(`  ⛔ ${method} → ${err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err)}`);
		return null;
	}
}

async function main(): Promise<void> {
	// 1. Типы складских документов (какой = списание, какой = оприходование)
	hr('1. ТИПЫ ДОКУМЕНТОВ (catalog.enum.getStoreDocumentTypes)');
	const types = await tryCall('catalog.enum.getStoreDocumentTypes', {});
	j('типы документов', types);

	// 2. Поля документа (что нужно для создания: тип, склад, ответственный, статус…)
	hr('2. ПОЛЯ ДОКУМЕНТА (catalog.document.getFields)');
	const fields = await tryCall<{ fields?: Record<string, unknown> }>('catalog.document.getFields', {});
	if (fields?.fields) {
		console.log(`полей: ${Object.keys(fields.fields).length}`);
		j('поля документа', fields.fields);
	}

	// 3. Поля строки документа (storeFrom/storeTo, elementId, amount, purchasingPrice…)
	hr('3. ПОЛЯ СТРОКИ (catalog.document.element.getFields)');
	const elFields = await tryCall<{ fields?: Record<string, unknown> }>('catalog.document.element.getFields', {});
	if (elFields?.fields) {
		console.log(`полей строки: ${Object.keys(elFields.fields).length}`);
		j('поля строки', elFields.fields);
	}

	// 4. Существующие документы — распределение по типам и статусам
	hr('4. СУЩЕСТВУЮЩИЕ ДОКУМЕНТЫ (catalog.document.list)');
	const docs = await tryCall<{ documents?: Array<Record<string, unknown>> }>('catalog.document.list', {
		select: ['id', 'docType', 'status', 'title', 'total', 'responsibleId', 'dateCreate', 'dateModify'],
		order: { id: 'DESC' },
	});
	const list = docs?.documents ?? [];
	const byType: Record<string, number> = {};
	const byStatus: Record<string, number> = {};
	for (const d of list) {
		byType[String(d['docType'])] = (byType[String(d['docType'])] ?? 0) + 1;
		byStatus[String(d['status'])] = (byStatus[String(d['status'])] ?? 0) + 1;
	}
	console.log(`документов в выборке: ${list.length}`);
	j('по типам (docType)', byType);
	j('по статусам (status: Y=проведён, N=черновик?)', byStatus);
	j('последние 8 (тип/статус/заголовок)', list.slice(0, 8).map((d) => ({ id: d['id'], docType: d['docType'], status: d['status'], title: d['title'], total: d['total'] })));

	// 5. По одному примеру строк на каждый тип — структура (откуда/куда склад, кол-во, закупка)
	hr('5. СТРОКИ ДОКУМЕНТОВ по типам (catalog.document.element.list)');
	const seen = new Set<string>();
	for (const d of list) {
		const t = String(d['docType']);
		if (seen.has(t)) continue;
		seen.add(t);
		const els = await tryCall<{ documentElements?: Array<Record<string, unknown>> }>('catalog.document.element.list', {
			filter: { docId: Number(d['id']) },
		});
		const arr = (els?.documentElements ?? []).slice(0, 2);
		console.log(`\n— docType=${t} (doc #${d['id']}, status=${d['status']}) — строк показываю ${arr.length} —`);
		j('строки (storeFrom/storeTo/elementId/amount/purchasingPrice)', arr);
	}

	// 6. Какие вообще catalog.document.* методы доступны (создание/проведение)
	hr('6. catalog.document.* и catalog.store.* МЕТОДЫ (methods)');
	const all = await tryCall('methods', {});
	const names = Array.isArray(all) ? all.map(String) : all && typeof all === 'object' ? Object.keys(all) : [];
	j('catalog.document.* / conduct / store', names.filter((n) => /document|conduct|store\.list|storeproduct/i.test(n)).sort());

	hr('ГОТОВО — ничего не создано и не проведено');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
