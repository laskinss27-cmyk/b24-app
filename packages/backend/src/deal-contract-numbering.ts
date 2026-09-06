import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateBridge } from './remaining-sql/runtime.js';
import { contentHash } from './remaining-sql/codec.js';

const sequenceSql = new StateBridge<Record<string, number>>('sequences');
export interface ContractCommand { documentId: string; contractNumber: string; createdAt: string }
export async function findContractCommand(key: string, requestHash: string): Promise<ContractCommand | null> {
	if (sequenceSql.mode !== 'primary') return null;
	const c = await sequenceSql.runtime!.pool.getConnection();
	try {
		const rows = await c.query('SELECT * FROM app_contract_commands WHERE idempotency_key=?', [key]);
		if (!rows.length) return null;
		if (rows[0].request_hash !== requestHash) throw new Error('Запрос договора с этим ключом уже отличается');
		return { documentId: rows[0].document_id, contractNumber: rows[0].contract_number, createdAt: rows[0].created_at_iso };
	} finally { await c.release(); }
}
export async function recoverContractSequenceMirror(path: string) {
	return sequenceSql.recover('global', async state => {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary,path);
	});
}

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
	idempotencyKey?: string;
	requestHash?: string;
	baselineValues?: Record<string,number>;
}): Promise<string> {
	let release!: () => void;
	const previous = contractSequenceQueue;
	contractSequenceQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
	await previous;
	try {
		return await sequenceSql.mutate('global', async () => {
		const key = args.idempotencyKey;
		const requestHash = args.requestHash ?? contentHash({ key: args.key, baseline: args.baseline, requested: args.requested ?? '' });
		if (sequenceSql.mode === 'primary' && key) {
			if (!/^[a-zA-Z0-9:_-]{16,160}$/.test(key)) throw new Error('Invalid contract idempotency key');
			const rows = await sequenceSql.connection('global').query('SELECT request_hash,contract_number FROM app_contract_commands WHERE idempotency_key=?', [key]);
			if (rows.length) { if (rows[0].request_hash !== requestHash) throw new Error('Conflicting contract request'); return String(rows[0].contract_number); }
		}
		let state: Record<string, number> = {};
		state = await sequenceSql.read('global', async () => {
		let file: Record<string,number> = {};
		try {
			file = JSON.parse(await readFile(args.path, 'utf8')) as Record<string, number>;
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		}
		if (sequenceSql.mode !== 'off') for (const [key,value] of Object.entries(args.baselineValues ?? {})) {
			if (!Number.isSafeInteger(value) || value<0) throw new Error('Invalid legacy sequence baseline');
			file[key] = Math.max(file[key] ?? 0,value);
		}
		return file;
		});
		const previousValues = (args.previousKeys ?? [])
			.map((key) => Number(state[key] ?? 0))
			.filter(Number.isFinite);
		const current = Math.max(Number(state[args.key] ?? 0), args.baseline, ...previousValues);
		const requested = Number.parseInt(args.requested ?? '', 10);
		const next = Number.isInteger(requested) && requested > current ? requested : current + 1;
		if (!Number.isSafeInteger(next) || next <= 0) throw new Error('Invalid contract sequence');
		state[args.key] = next;
		await sequenceSql.write('global', state, async rows => {
		await mkdir(dirname(args.path), { recursive: true });
		const temporaryPath = `${args.path}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
		await rename(temporaryPath, args.path);
		});
		if (sequenceSql.mode === 'primary' && key) await sequenceSql.connection('global').query('INSERT INTO app_contract_commands(idempotency_key,request_hash,document_id,contract_number,created_at_iso) VALUES (?,?,?,?,?)', [key,requestHash,randomUUID(),String(next),new Date().toISOString()]);
		return String(next);
		});
	} finally {
		release();
	}
}
