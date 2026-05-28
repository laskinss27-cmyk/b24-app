/**
 * Скачивает метаданные полей Б24 через DEV_WEBHOOK и сохраняет
 * в packages/shared/src/b24-fields/<entity>.json как reference.
 *
 * Запуск: npm run gen:types
 * Требует: DEV_WEBHOOK в .env (на корне или в packages/backend/.env)
 *
 * Это НЕ генератор TS-кода — это снимок схемы портала. JSON-файлы
 * коммитятся, чтоб любой разработчик мог открыть и посмотреть какие
 * поля есть, какие UF_CRM_* живут на сделке этого портала, без
 * заглядывания в Битрикс UI.
 *
 * Обновлять: при появлении новых UF на портале, или при смене портала.
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUTPUT_DIR = join(REPO_ROOT, 'packages', 'shared', 'src', 'b24-fields');

interface MetadataTarget {
	method: string;
	outFile: string;
	params?: Record<string, unknown>;
}

const TARGETS: MetadataTarget[] = [
	{ method: 'crm.deal.fields', outFile: 'deal.json' },
	{ method: 'crm.deal.userfield.list', outFile: 'deal.userfields.json', params: { order: { SORT: 'ASC' } } },
	{ method: 'crm.productrow.fields', outFile: 'productrow.json' },
	{ method: 'crm.product.fields', outFile: 'product.json' },
	{ method: 'crm.product.property.list', outFile: 'product.properties.json', params: { filter: {} } },
	{ method: 'crm.catalog.list', outFile: 'catalogs.json' },
	{ method: 'crm.currency.list', outFile: 'currencies.json' },
];

async function main(): Promise<void> {
	const webhook = process.env['DEV_WEBHOOK'];
	if (!webhook) {
		console.error('DEV_WEBHOOK не задан. Скопируйте packages/backend/.env.example в .env и пропишите.');
		process.exit(1);
	}

	const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

	await mkdir(OUTPUT_DIR, { recursive: true });

	for (const target of TARGETS) {
		process.stdout.write(`→ ${target.method} ... `);
		try {
			const result = await client.call(target.method, target.params ?? {});
			const filePath = join(OUTPUT_DIR, target.outFile);
			await writeFile(filePath, JSON.stringify(result, null, '\t') + '\n', 'utf-8');
			const size = Array.isArray(result)
				? `${result.length} items`
				: typeof result === 'object' && result !== null
					? `${Object.keys(result).length} keys`
					: 'ok';
			process.stdout.write(`${size} → ${target.outFile}\n`);
		} catch (err) {
			if (err instanceof B24ApiError) {
				console.warn(`SKIPPED (${err.code}: ${err.description ?? ''})`);
			} else {
				console.error('FAILED:', err);
			}
		}
	}

	console.log('\nDone. Файлы в packages/shared/src/b24-fields/');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
