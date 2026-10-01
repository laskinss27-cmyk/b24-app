import { z } from 'zod';
import { SUPPORT_MAX_FILES, SUPPORT_MAX_FILE_BYTES, type SupportUpload } from '@b24-app/shared';

export const requestIdSchema = z.string().uuid();
export const supportCreateSchema = z.object({
	requestId: requestIdSchema, reference: z.string().trim().max(300).default(''),
	context: z.string().trim().max(300).default(''), description: z.string().trim().min(10).max(5000),
	expected: z.string().trim().min(3).max(2000), attachments: z.array(z.object({
		name: z.string().min(1).max(150), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
		base64: z.string().min(1).max(Math.ceil(SUPPORT_MAX_FILE_BYTES / 3) * 4),
	})).max(SUPPORT_MAX_FILES).default([]),
});
export const supportFollowupSchema = supportCreateSchema.pick({ requestId: true, attachments: true }).extend({
	ticketId: z.number().int().positive(), text: z.string().trim().min(3).max(5000),
});
export type SupportCreate = z.infer<typeof supportCreateSchema>;
export type SupportFollowup = z.infer<typeof supportFollowupSchema>;
export class SupportError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}
export function decodeScreenshot(file: SupportUpload): Buffer {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64)) throw new SupportError('Некорректное содержимое скриншота');
	const bytes = Buffer.from(file.base64, 'base64');
	if (!bytes.length || bytes.length > SUPPORT_MAX_FILE_BYTES || bytes.toString('base64') !== file.base64) {
		throw new SupportError('Скриншот должен быть не больше 2 МБ');
	}
	const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
	const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
	if (!(file.mime === 'image/png' && png || file.mime === 'image/jpeg' && jpeg || file.mime === 'image/webp' && webp)) {
		throw new SupportError('Прикрепите скриншот в формате PNG, JPEG или WebP');
	}
	return bytes;
}
export function screenshotName(name: string, mime: string): string {
	const stem = name.replace(/\.[^.]+$/, '').replace(/[\\/\[\]\x00-\x1f]/g, '_').slice(0, 100) || 'Скриншот';
	return `${stem}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'}`;
}
