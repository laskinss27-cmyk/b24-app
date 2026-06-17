/**
 * МИГРАЦИЯ ФОТО товаров Б24 → ERPNext Item.image (фаза «вынос фото»).
 * Фото живут в галерее property104 на ПРЕДЛОЖЕНИЯх (iblock 26); скачиваются через
 * catalog.product.download (url с токеном в пути вебхука). Грузим в Item.image ядра
 * (item_code = productId). ИДЕМПОТЕНТНО: у кого image уже есть — пропускаем.
 *
 * Запуск (на спейре, прямой Б24 + localhost-ядро):
 *   npx tsx scripts/erp-migrate-photos.ts            — dry: покрытие, ничего не пишет
 *   npx tsx scripts/erp-migrate-photos.ts --run --limit 1   — тест на одном
 *   npx tsx scripts/erp-migrate-photos.ts --run      — полный прогон
 */
import 'dotenv/config';
import { request as undiciRequest, Agent } from 'undici';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';

const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl';
const PROXY_URL = process.env['LOCAL_PROXY'] ?? (process.platform === 'win32' ? 'http://127.0.0.1:10809' : '');
const localAgent = new Agent();
const execFileP = promisify(execFile);
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
if (!WEBHOOK) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? '';
const ITEM_GROUP = 'Каталог Б24';
const TMP = process.platform === 'win32' ? process.env['TEMP'] ?? '.' : '/tmp';

const args = new Set(process.argv.slice(2));
const RUN = args.has('--run');
const limArg = process.argv.find((a) => a.startsWith('--limit'));
const LIMIT = limArg ? Number(process.argv[process.argv.indexOf(limArg) + 1]) : 0;

async function b24call<T>(method: string, params: Record<string, unknown>): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= 5; a++) {
		try {
			const { stdout } = await execFileP(CURL, [
				'-s', ...(PROXY_URL ? ['-x', PROXY_URL] : []), '--connect-timeout', '15', '--max-time', '60',
				'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
			], { maxBuffer: 64 * 1024 * 1024 });
			const json = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
			if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
			return json.result as T;
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, a * 700)); }
	}
	throw last;
}

async function erp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await undiciRequest(`${ERP}${path}`, {
		method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
		headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		dispatcher: localAgent,
	});
	const text = await res.body.text();
	let json: any = null;
	try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
	return { status: res.statusCode, json };
}

/** url первой картинки галереи property104: форма [{value:{url}}] или {url}. */
function galleryUrl(v: unknown): string | undefined {
	const f = Array.isArray(v) ? v[0] : v;
	if (f && typeof f === 'object') {
		const inner = (f as Record<string, unknown>)['value'] ?? f;
		if (inner && typeof inner === 'object') {
			const u = (inner as Record<string, unknown>)['url'];
			if (typeof u === 'string' && u) return u;
		}
	}
	return undefined;
}

/** Все товары ОБЕИХ веток (24 базовые + 26 предложения) с url фото — постранично.
 *  Фото бывает в property104 (галерея, у предложений) ИЛИ detailPicture/previewPicture (у базовых). */
async function collectPhotos(): Promise<Array<{ productId: number; url: string }>> {
	const out: Array<{ productId: number; url: string }> = [];
	for (const iblockId of [24, 26]) {
		for (let start = 0; ; start += 50) {
			const res = await b24call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
				select: ['id', 'iblockId', 'property104', 'detailPicture', 'previewPicture'], filter: { iblockId }, order: { id: 'ASC' }, start,
			});
			const ps = res?.products ?? [];
			if (!ps.length) break;
			for (const p of ps) {
				const url = galleryUrl(p['property104']) ?? galleryUrl(p['detailPicture']) ?? galleryUrl(p['previewPicture']);
				if (url) out.push({ productId: Number(p['id']), url });
			}
			if (ps.length < 50) break;
		}
	}
	return out;
}

/** Скачать картинку из Б24 в base64 (с проверкой, что это реально картинка). */
async function downloadImage(productId: number, url: string): Promise<{ b64: string; ext: string } | null> {
	const full = `${WEBHOOK}/${url.replace(/^\/rest\//, '')}`;
	const tmp = `${TMP}/kpimg_${productId}.bin`;
	try {
		await execFileP(CURL, ['-s', ...(PROXY_URL ? ['-x', PROXY_URL] : []), '--max-time', '60', '-L', '-o', tmp, full], { maxBuffer: 1024 });
		if (!existsSync(tmp)) return null;
		const buf = readFileSync(tmp);
		unlinkSync(tmp);
		if (buf.length < 100) return null;
		const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
		const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
		if (!isJpg && !isPng) return null; // вернулся не образ (ошибка/JSON) — пропускаем
		return { b64: buf.toString('base64'), ext: isPng ? 'png' : 'jpg' };
	} catch { try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ } return null; }
}

/** Загрузить файл в ERPNext (File с base64+decode) и проставить Item.image его file_url. */
async function uploadToItem(code: string, b64: string, ext: string): Promise<boolean> {
	const f = await erp('POST', '/api/resource/File', {
		file_name: `${code}.${ext}`, content: b64, decode: 1, is_private: 0,
		attached_to_doctype: 'Item', attached_to_name: code,
	});
	const fileUrl = f.json?.data?.file_url;
	if (f.status >= 300 || !fileUrl) return false;
	const u = await erp('PUT', `/api/resource/Item/${encodeURIComponent(code)}`, { image: fileUrl });
	return u.status < 300;
}

async function main(): Promise<void> {
	if (RUN && !ERP_AUTH) { console.error('ERPNEXT_TOKEN нет — для --run обязателен'); process.exit(1); }
	console.log(`Режим: ${RUN ? 'RUN (пишем в ядро)' : 'DRY (только счёт)'}${LIMIT ? `, лимит ${LIMIT}` : ''}`);
	console.log('Собираю офферы с фото из Б24…');
	const photos = await collectPhotos();
	console.log(`Офферов с property104-фото: ${photos.length}`);

	// какие Item'ы уже с картинкой — пропускаем
	const items = await erp('GET', `/api/resource/Item?fields=${encodeURIComponent(JSON.stringify(['name', 'image']))}&filters=${encodeURIComponent(JSON.stringify([['item_group', '=', ITEM_GROUP]]))}&limit_page_length=0`);
	const haveImg = new Set<string>();
	const exist = new Set<string>();
	for (const it of (items.json?.data ?? [])) { exist.add(String(it.name)); if (it.image) haveImg.add(String(it.name)); }
	console.log(`Item'ов в ядре: ${exist.size}, уже с фото: ${haveImg.size}`);

	const todo = photos.filter((p) => exist.has(String(p.productId)) && !haveImg.has(String(p.productId)));
	console.log(`К загрузке (есть Item, нет фото): ${todo.length}`);
	if (!RUN) { console.log('DRY — стоп. Для записи: --run'); return; }

	let ok = 0, skip = 0, fail = 0;
	const list = LIMIT ? todo.slice(0, LIMIT) : todo;
	for (const p of list) {
		const code = String(p.productId);
		const img = await downloadImage(p.productId, p.url);
		if (!img) { fail++; console.log(`  ✗ ${code}: не скачалось/не образ`); continue; }
		const up = await uploadToItem(code, img.b64, img.ext);
		if (up) { ok++; if (ok % 50 === 0) console.log(`  …загружено ${ok}`); }
		else { fail++; console.log(`  ✗ ${code}: upload_file не принял`); }
	}
	console.log(`ИТОГ: загружено ${ok}, пропущено ${skip}, ошибок ${fail}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
