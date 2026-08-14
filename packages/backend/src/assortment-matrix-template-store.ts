import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ActorSchema = z.object({
	id: z.string().regex(/^\d{1,12}$/),
	name: z.string().min(1).max(160),
}).strict();
const TemplateRowSchema = z.object({
	productId: z.number().int().positive(),
	category: z.string().max(140),
	segment: z.string().max(140),
	toOrderQty: z.number().finite().nonnegative(),
	comment: z.string().max(1000),
}).strict();
const TemplateSchema = z.object({
	id: z.string().uuid(),
	name: z.string().min(1).max(80),
	from: DateSchema,
	to: DateSchema,
	selectedStores: z.array(z.string().min(1).max(160)).max(50),
	salesScope: z.enum(['selected', 'all']),
	rows: z.array(TemplateRowSchema).max(1000),
	createdAt: z.string().datetime(),
	createdBy: ActorSchema,
	updatedAt: z.string().datetime(),
	updatedBy: ActorSchema,
}).strict();
const FileSchema = z.object({ version: z.literal(1), templates: z.array(TemplateSchema).max(100) }).strict();

export type AssortmentMatrixTemplateRow = z.infer<typeof TemplateRowSchema>;
export type AssortmentMatrixTemplateActor = z.infer<typeof ActorSchema>;
export type AssortmentMatrixTemplate = z.infer<typeof TemplateSchema>;

export interface SaveAssortmentMatrixTemplateInput {
	id?: string;
	name: string;
	from: string;
	to: string;
	selectedStores: string[];
	salesScope: 'selected' | 'all';
	rows: AssortmentMatrixTemplateRow[];
	expectedUpdatedAt?: string;
}

export class AssortmentMatrixTemplateConflictError extends Error {}

export class AssortmentMatrixTemplateStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly filePath = join(process.env['B24_STATE_DIR'] ?? '/app/state', 'assortment-matrix', 'templates.json')) {}

	private async read(): Promise<AssortmentMatrixTemplate[]> {
		try {
			const parsed = FileSchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown);
			if (!parsed.success) throw new Error('файл шаблонов матрицы повреждён и не будет перезаписан автоматически');
			return parsed.data.templates;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	}

	private async write(templates: AssortmentMatrixTemplate[]): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ version: 1, templates }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		try {
			await rename(temporary, this.filePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST' && code !== 'EPERM') throw error;
			await rm(this.filePath, { force: true });
			await rename(temporary, this.filePath);
		}
	}

	private async queued<T>(task: () => Promise<T>): Promise<T> {
		const current = this.queue.catch(() => undefined).then(task);
		this.queue = current;
		try {
			return await current;
		} finally {
			if (this.queue === current) this.queue = Promise.resolve();
		}
	}

	async list(): Promise<AssortmentMatrixTemplate[]> {
		return (await this.read()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async save(actor: AssortmentMatrixTemplateActor, input: SaveAssortmentMatrixTemplateInput): Promise<AssortmentMatrixTemplate> {
		return this.queued(async () => {
			const normalizedActor = ActorSchema.parse({ id: String(actor.id), name: String(actor.name).trim() || `#${actor.id}` });
			const name = String(input.name).trim();
			const from = String(input.from);
			const to = String(input.to);
			const selectedStores = [...new Set(input.selectedStores.map((store) => String(store).trim()).filter(Boolean))];
			const rows = input.rows.map((row) => TemplateRowSchema.parse({
				productId: Number(row.productId),
				category: String(row.category).trim(),
				segment: String(row.segment).trim(),
				toOrderQty: Number(row.toOrderQty),
				comment: String(row.comment).trim(),
			}));
			if (!name || name.length > 80) throw new Error('название шаблона должно содержать от 1 до 80 символов');
			if (!DateSchema.safeParse(from).success || !DateSchema.safeParse(to).success || from > to) throw new Error('проверь период шаблона');
			if (!selectedStores.length || selectedStores.length > 50) throw new Error('выбери хотя бы один склад');
			if (new Set(rows.map((row) => row.productId)).size !== rows.length) throw new Error('товар не должен повторяться в шаблоне');
			if (rows.length > 1000) throw new Error('в одном шаблоне может быть не больше 1000 товаров');

			const templates = await this.read();
			const now = new Date().toISOString();
			if (input.id) {
				const index = templates.findIndex((template) => template.id === input.id);
				const current = templates[index];
				if (!current) throw new Error('шаблон матрицы не найден');
				if (input.expectedUpdatedAt && input.expectedUpdatedAt !== current.updatedAt) {
					throw new AssortmentMatrixTemplateConflictError('шаблон уже изменён другим пользователем — открой его заново');
				}
				const updated = TemplateSchema.parse({ ...current, name, from, to, selectedStores, salesScope: input.salesScope, rows, updatedAt: now, updatedBy: normalizedActor });
				templates[index] = updated;
				await this.write(templates);
				return updated;
			}
			if (templates.length >= 100) throw new Error('достигнут предел в 100 шаблонов матрицы');
			const created = TemplateSchema.parse({
				id: randomUUID(), name, from, to, selectedStores, salesScope: input.salesScope, rows,
				createdAt: now, createdBy: normalizedActor, updatedAt: now, updatedBy: normalizedActor,
			});
			templates.push(created);
			await this.write(templates);
			return created;
		});
	}

	async delete(id: string): Promise<boolean> {
		return this.queued(async () => {
			if (!z.string().uuid().safeParse(id).success) return false;
			const templates = await this.read();
			const next = templates.filter((template) => template.id !== id);
			if (next.length === templates.length) return false;
			await this.write(next);
			return true;
		});
	}
}
