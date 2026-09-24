import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyReservationState, type ReservationState } from './model.js';

export class ReservationStore {
	private queue: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async read(): Promise<ReservationState> {
		await this.queue;
		try {
			const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<ReservationState>;
			if (parsed.version !== 1 || !parsed.items || typeof parsed.items !== 'object') return emptyReservationState();
			return { version: 1, lastScanAt: String(parsed.lastScanAt ?? ''), items: parsed.items } as ReservationState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyReservationState();
			throw error;
		}
	}

	async write(state: ReservationState): Promise<void> {
		const persist = async (): Promise<void> => {
			await mkdir(dirname(this.filePath), { recursive: true });
			const temporary = `${this.filePath}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
			await rename(temporary, this.filePath);
		};
		this.queue = this.queue.then(persist, persist);
		await this.queue;
	}
}
