import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ReportDefinitionSchema, validateReportDefinition, type ReportDefinition, type SavedReport } from './model.js';

const SavedReportSchema = z.object({
	id: z.string().uuid(),
	name: z.string().min(1).max(80),
	definition: ReportDefinitionSchema,
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
}).strict();

const StoreFileSchema = z.object({
	version: z.literal(1),
	reports: z.array(SavedReportSchema).max(200),
}).strict();

export class ReportStoreConflictError extends Error {}

export interface SaveReportInput {
	id?: string;
	name: string;
	definition: ReportDefinition;
	expectedUpdatedAt?: string;
}

export class ReportBuilderStore {
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(private readonly root = join(process.env['B24_STATE_DIR'] ?? '/app/state', 'report-builder')) {}

	private ownerPath(ownerId: string): string {
		if (!/^\d{1,12}$/.test(ownerId)) throw new Error('некорректный ID владельца отчёта');
		return join(this.root, `${ownerId}.json`);
	}

	private async read(ownerId: string): Promise<SavedReport[]> {
		try {
			const raw = JSON.parse(await readFile(this.ownerPath(ownerId), 'utf8')) as unknown;
			const parsed = StoreFileSchema.safeParse(raw);
			if (!parsed.success) throw new Error('файл личных отчётов повреждён и не будет перезаписан автоматически');
			return parsed.data.reports;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	}

	private async write(ownerId: string, reports: SavedReport[]): Promise<void> {
		await mkdir(this.root, { recursive: true });
		const target = this.ownerPath(ownerId);
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify({ version: 1, reports }, null, 2), { encoding: 'utf8', mode: 0o600 });
		try {
			await rename(temporary, target);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST' && code !== 'EPERM') throw error;
			await rm(target, { force: true });
			await rename(temporary, target);
		}
	}

	private async queued<T>(ownerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(ownerId) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(task);
		this.queues.set(ownerId, current);
		try {
			return await current;
		} finally {
			if (this.queues.get(ownerId) === current) this.queues.delete(ownerId);
		}
	}

	async list(ownerId: string): Promise<SavedReport[]> {
		return (await this.read(ownerId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async save(ownerId: string, input: SaveReportInput): Promise<SavedReport> {
		return this.queued(ownerId, async () => {
			const name = input.name.trim();
			if (!name || name.length > 80) throw new Error('название отчёта должно содержать от 1 до 80 символов');
			const definition = validateReportDefinition(input.definition);
			const reports = await this.read(ownerId);
			const now = new Date().toISOString();
			if (input.id) {
				const index = reports.findIndex((report) => report.id === input.id);
				if (index < 0) throw new Error('личный отчёт не найден');
				const current = reports[index];
				if (!current) throw new Error('личный отчёт не найден');
				if (input.expectedUpdatedAt && input.expectedUpdatedAt !== current.updatedAt) {
					throw new ReportStoreConflictError('отчёт уже изменён в другом окне — откройте его заново');
				}
				const updated: SavedReport = { ...current, name, definition, updatedAt: now };
				reports[index] = updated;
				await this.write(ownerId, reports);
				return updated;
			}
			const created: SavedReport = { id: randomUUID(), name, definition, createdAt: now, updatedAt: now };
			reports.push(created);
			await this.write(ownerId, reports);
			return created;
		});
	}

	async delete(ownerId: string, id: string): Promise<boolean> {
		return this.queued(ownerId, async () => {
			if (!z.string().uuid().safeParse(id).success) return false;
			const reports = await this.read(ownerId);
			const next = reports.filter((report) => report.id !== id);
			if (next.length === reports.length) return false;
			await this.write(ownerId, next);
			return true;
		});
	}
}
