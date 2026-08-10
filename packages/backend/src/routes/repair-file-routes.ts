import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

interface RepairPhoto { id: number; name: string; url: string }

type RepairClientFrom = (body: AuthBody) => B24Client | null;
type RepairSystemClient = () => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairFileRoutes(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
): void {
	// Загрузка фото на Б24 Диск (хранилище приложения). Возвращает ссылку для карточки.
	// Best-effort: если Диск недоступен — фронт сохранит ремонт без фото.
	app.get('/api/repairs/file/:id', async (req, reply) => {
		const id = Number((req.params as { id?: string }).id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad file id' });
		const client = systemClient() ?? clientFrom(req.query as AuthBody);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет доступа к Б24 Диску' });
		try {
			const file = await client.call<Record<string, unknown>>('disk.file.get', { id });
			const url = String(file?.['DOWNLOAD_URL'] ?? file?.['downloadUrl'] ?? file?.['DETAIL_URL'] ?? '');
			if (!url) return reply.code(404).send({ ok: false, error: 'ссылка на файл не получена' });
			return reply.redirect(url);
		} catch (err) {
			app.log.warn({ fileId: id }, `[api/repairs/file] failed — ${errInfo(err)}`);
			return reply.code(404).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/repairs/file-link', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad file id' });
		const client = systemClient() ?? clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'нет доступа к Б24 Диску' });
		try {
			const file = await client.call<Record<string, unknown>>('disk.file.get', { id });
			const url = String(file?.['DOWNLOAD_URL'] ?? file?.['downloadUrl'] ?? file?.['DETAIL_URL'] ?? '');
			if (!url) return reply.code(404).send({ ok: false, error: 'ссылка на файл не получена' });
			return { ok: true, url };
		} catch (err) {
			app.log.warn({ fileId: id }, `[api/repairs/file-link] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/repairs/upload-photo', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { fileName?: unknown; content?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const fileName = String(b.fileName ?? 'photo.jpg').replace(/[^\w.\-а-яё ]/gi, '_').slice(0, 80);
		const content = String(b.content ?? ''); // base64 без префикса data:
		if (!content) return reply.code(400).send({ ok: false, error: 'нет содержимого файла' });
		try {
			const storage = await client.call<{ ID?: number | string }>('disk.storage.getforapp', {});
			const storageId = Number(storage?.ID);
			if (!storageId) throw new Error('disk.storage.getforapp не вернул хранилище');
			const file = await client.call<Record<string, unknown>>('disk.storage.uploadfile', {
				id: storageId,
				data: { NAME: fileName },
				fileContent: [fileName, content],
				generateUniqueName: true,
			});
			const photo: RepairPhoto = {
				id: Number(file?.['ID']) || 0,
				name: String(file?.['NAME'] ?? fileName),
				url: Number(file?.['ID']) > 0 ? `/api/repairs/file/${Number(file?.['ID'])}` : String(file?.['DOWNLOAD_URL'] ?? file?.['DETAIL_URL'] ?? ''),
			};
			app.log.info({ id: photo.id }, '[api/repairs/upload-photo] ok');
			return { ok: true, photo };
		} catch (err) {
			app.log.warn({}, `[api/repairs/upload-photo] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
