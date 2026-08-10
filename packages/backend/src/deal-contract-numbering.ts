import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CONTRACT_NUMBER_START_BY_INN: Readonly<Record<string, number>> = {
	'780525373242': 520, // ИП Поляков Д. Ю.
	'7816473082': 250, // ООО «Дом Бизнес Строй»
	'470379634080': 120, // ИП Нагайцев О. А.
	'7816287495': 450, // ООО «Новый Дом»
	'7816268460': 200, // ООО «РА Анемоне»
	'7842177523': 450, // ООО «И-ОН»
};

const clean = (value: unknown): string => String(value ?? '').trim();

export function contractNumberStartByInn(inn: string): number {
	return CONTRACT_NUMBER_START_BY_INN[clean(inn)] ?? 1;
}

let contractSequenceQueue: Promise<void> = Promise.resolve();

export async function allocatePersistentContractNumber(args: {
	path: string;
	key: string;
	baseline: number;
	previousKeys?: string[];
	requested?: string;
}): Promise<string> {
	let release!: () => void;
	const previous = contractSequenceQueue;
	contractSequenceQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
	await previous;
	try {
		let state: Record<string, number> = {};
		try {
			state = JSON.parse(await readFile(args.path, 'utf8')) as Record<string, number>;
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		}
		const previousValues = (args.previousKeys ?? [])
			.map((key) => Number(state[key] ?? 0))
			.filter(Number.isFinite);
		const current = Math.max(Number(state[args.key] ?? 0), args.baseline, ...previousValues);
		const requested = Number.parseInt(args.requested ?? '', 10);
		const next = Number.isInteger(requested) && requested > current ? requested : current + 1;
		state[args.key] = next;
		await mkdir(dirname(args.path), { recursive: true });
		const temporaryPath = `${args.path}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
		await rename(temporaryPath, args.path);
		return String(next);
	} finally {
		release();
	}
}
