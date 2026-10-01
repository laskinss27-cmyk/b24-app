import { SUPPORT_MAX_FILES, SUPPORT_MAX_FILE_BYTES, type SupportUpload } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';

export class SupportRequestError extends Error {
	constructor(message: string, readonly uncertain = false) { super(message); }
}
export type SupportApi = <T>(action: string, body?: Record<string, unknown>) => Promise<T>;
export const supportApi: SupportApi = async <T,>(action: string, body: Record<string, unknown> = {}): Promise<T> => {
	if (window.BX24) await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new SupportRequestError('Битрикс24 не ответил. Перезагрузите вкладку и повторите')), 8000);
		window.BX24!.init(() => { clearTimeout(timeout); resolve(); });
	});
	let auth: ReturnType<typeof bx24Auth>;
	try { auth = bx24Auth(); } catch { throw new SupportRequestError('Откройте ERP из Битрикс24, чтобы отправить обращение'); }
	let response: Response;
	try {
		response = await fetch(`/api/support/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...body, ...auth }), signal: AbortSignal.timeout(30000) });
	} catch { throw new SupportRequestError('Ответ сервера не получен. Повторите отправку: дубль не создастся', true); }
	if (action === 'attachment' && response.ok) return await response.blob() as T;
	let result: { ok?: boolean; error?: string };
	try { result = await response.json() as typeof result; }
	catch { throw new SupportRequestError('Не удалось прочитать ответ. Повторите запрос', true); }
	if (!response.ok || !result.ok) throw new SupportRequestError(result.error || 'Не удалось обработать обращение', response.status >= 500);
	return result as T;
};

export async function readSupportScreenshots(files: File[], currentCount: number): Promise<SupportUpload[]> {
	if (currentCount + files.length > SUPPORT_MAX_FILES) throw new Error('Можно прикрепить до 3 скриншотов за одну отправку');
	for (const file of files) {
		if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Скриншоты: PNG, JPEG или WebP');
		if (!file.size || file.size > SUPPORT_MAX_FILE_BYTES) throw new Error(`«${file.name}»: размер должен быть не больше 2 МБ`);
	}
	return Promise.all(files.map((file) => new Promise<SupportUpload>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`Не удалось прочитать «${file.name}»`));
		reader.onload = () => resolve({ name: file.name, mime: file.type, base64: String(reader.result).split(',')[1] ?? '' });
		reader.readAsDataURL(file);
	})));
}
