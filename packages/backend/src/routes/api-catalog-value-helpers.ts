import { coreStoreId } from '../erp/operations.js';

export function cleanText(value: unknown): string {
	return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function cleanMultiline(value: unknown): string {
	return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, 10_000);
}

const CATALOG_PHOTO_MAX_BYTES = 800 * 1024;
const CATALOG_PHOTO_TYPES = new Map([
	['image/jpeg', { extension: 'jpg', signature: (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
	['image/png', { extension: 'png', signature: (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
	['image/webp', { extension: 'webp', signature: (bytes: Buffer) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' }],
] as const);

export function catalogPhoto(value: unknown): { fileName: string; mimeType: string; content: Buffer } | null {
	if (value == null || value === '') return null;
	if (!value || typeof value !== 'object') throw new Error('сервер получил неверное фото товара');
	const row = value as Record<string, unknown>;
	const mimeType = cleanText(row['mimeType']).toLocaleLowerCase('en-US');
	const kind = CATALOG_PHOTO_TYPES.get(mimeType as 'image/jpeg' | 'image/png' | 'image/webp');
	if (!kind) throw new Error('фото должно быть в формате JPEG, PNG или WebP');
	const encoded = String(row['content'] ?? '').replace(/^data:[^,]*,/u, '').trim();
	if (!encoded || !/^[a-z0-9+/]+={0,2}$/iu.test(encoded)) throw new Error('фото товара повреждено');
	const content = Buffer.from(encoded, 'base64');
	if (!content.length || !kind.signature(content)) throw new Error('содержимое фото не соответствует его формату');
	if (content.length > CATALOG_PHOTO_MAX_BYTES) {
		throw new Error(`фото после подготовки должно весить не больше ${Math.round(CATALOG_PHOTO_MAX_BYTES / 1024)} КБ`);
	}
	const original = cleanText(row['fileName']).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 70);
	const stem = original.replace(/\.[^.]+$/u, '').trim() || 'product';
	return { fileName: `${stem}.${kind.extension}`, mimeType, content };
}

export function normalized(value: unknown): string {
	return cleanText(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '');
}

export function normalizedStoreTitle(value: unknown): string {
	return cleanText(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

export function coreSectionId(title: string): number {
	return Math.abs(coreStoreId(`section:${title}`));
}

export function productTitle(productType: string, manufacturer: string, model: string): string {
	return [productType, manufacturer, model].map(cleanText).filter(Boolean).join(' ');
}

export function propValue(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const raw = obj['valueEnum'] ?? obj['value'];
		return raw == null || raw === '' ? undefined : cleanText(raw);
	}
	const text = cleanText(value);
	return text || undefined;
}
