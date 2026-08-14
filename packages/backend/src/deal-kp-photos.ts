import type { DealKpDocumentData } from './deal-kp-docx.js';

export interface DealKpImage {
	buffer: Buffer;
	extension: 'jpeg' | 'png';
	contentType: 'image/jpeg' | 'image/png';
}

export type DealKpImages = Map<string, DealKpImage>;

interface DealKpPhotoAuth {
	domain?: string | undefined;
	accessToken?: string | undefined;
}

function portalDomain(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/+$/, '')
		.toLowerCase();
}

export function dealKpPhotoUrl(photoPath: string, auth: DealKpPhotoAuth): URL | null {
	const domain = portalDomain(auth.domain);
	const accessToken = String(auth.accessToken ?? '').trim();
	if (!domain || !accessToken || !photoPath.trim()) return null;
	let url: URL;
	try {
		url = photoPath.startsWith('/')
			? new URL(photoPath, `https://${domain}`)
			: new URL(photoPath);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== domain) return null;
	url.searchParams.set('auth', accessToken);
	return url;
}

function imageType(buffer: Buffer): Pick<DealKpImage, 'extension' | 'contentType'> | null {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return { extension: 'png', contentType: 'image/png' };
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return { extension: 'jpeg', contentType: 'image/jpeg' };
	}
	return null;
}

async function loadPhoto(photoPath: string, auth: DealKpPhotoAuth): Promise<DealKpImage | null> {
	const url = dealKpPhotoUrl(photoPath, auth);
	if (!url) return null;
	try {
		const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) });
		if (!response.ok) return null;
		const declaredSize = Number(response.headers.get('content-length') ?? 0);
		if (Number.isFinite(declaredSize) && declaredSize > 5_000_000) return null;
		const buffer = Buffer.from(await response.arrayBuffer());
		if (!buffer.length || buffer.length > 5_000_000) return null;
		const detected = imageType(buffer);
		return detected ? { buffer, ...detected } : null;
	} catch {
		return null;
	}
}

/**
 * Загружает фотографии только с текущего портала Битрикс24. Ошибка одной картинки
 * не должна мешать созданию КП: в документе останется пустая фотоячейка.
 */
export async function loadDealKpImages(data: DealKpDocumentData, auth: DealKpPhotoAuth): Promise<DealKpImages> {
	const paths = [...new Set(data.goods.map((row) => row.photoPath).filter((value): value is string => Boolean(value)))].slice(0, 40);
	const images: DealKpImages = new Map();
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < paths.length) {
			const path = paths[cursor++];
			if (!path) continue;
			const image = await loadPhoto(path, auth);
			if (image) images.set(path, image);
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, paths.length) }, () => worker()));
	return images;
}
