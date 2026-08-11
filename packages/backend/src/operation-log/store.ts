import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OperationLogEvent, OperationLogListFilter } from './model.js';
import { isOperationLogEvent } from './model.js';

export interface OperationLogStoreOptions {
	filePath: string;
	maxEntries?: number;
}

function normalizeLimit(value: number | undefined): number {
	if (!Number.isFinite(value)) return 100;
	return Math.max(1, Math.min(Math.trunc(value!), 500));
}

export class OperationLogStore {
	private readonly filePath: string;
	private readonly maxEntries: number;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: OperationLogStoreOptions) {
		this.filePath = options.filePath;
		this.maxEntries = Math.max(1, options.maxEntries ?? 5_000);
	}

	async append(event: OperationLogEvent): Promise<void> {
		const write = async (): Promise<void> => {
			const events = await this.readAll();
			events.push(event);
			const kept = events.slice(-this.maxEntries);
			await this.replace(kept);
		};
		this.queue = this.queue.then(write, write);
		await this.queue;
	}

	async list(filter: OperationLogListFilter = {}): Promise<OperationLogEvent[]> {
		await this.queue;
		const limit = normalizeLimit(filter.limit);
		return (await this.readAll())
			.filter((event) => !filter.area || event.area === filter.area)
			.filter((event) => !filter.outcome || event.outcome === filter.outcome)
			.slice(-limit)
			.reverse();
	}

	private async readAll(): Promise<OperationLogEvent[]> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		return raw.split('\n').flatMap((line) => {
			if (!line.trim()) return [];
			try {
				const parsed: unknown = JSON.parse(line);
				return isOperationLogEvent(parsed) ? [parsed] : [];
			} catch {
				return [];
			}
		});
	}

	private async replace(events: OperationLogEvent[]): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		const content = events.map((event) => JSON.stringify(event)).join('\n');
		await writeFile(temporary, content ? `${content}\n` : '', 'utf8');
		await rename(temporary, this.filePath);
	}
}
