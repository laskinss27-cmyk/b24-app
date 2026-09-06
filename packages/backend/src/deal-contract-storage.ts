import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CONTRACT_FILENAME_TITLES, CONTRACT_TEMPLATES } from './deal-contract-templates.js';
import type { ContractTemplateId, StoredDealContractDocument } from './deal-contract-types.js';
import { StateBridge } from './remaining-sql/runtime.js';
import { contentHash } from './remaining-sql/codec.js';

const contractSql = new StateBridge<StoredDealContractDocument[]>('contracts');
const fileHash = (file: Buffer) => createHash('sha256').update(file).digest('hex');

const CONTRACT_DOCUMENTS_PATH = process.env['CONTRACT_DOCUMENTS_PATH']
	?? (process.env['NODE_ENV'] === 'production'
		? '/app/state/contracts'
		: resolve(process.cwd(), '.tmp', 'contracts'));

const clean = (value: unknown): string => String(value ?? '').trim();
const isNotFound = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'ENOENT';
const storedContractId = (value: string): string => {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new Error('неверный идентификатор договора');
	}
	return value;
};
const storedContractDealDirectory = (dealId: number, basePath = CONTRACT_DOCUMENTS_PATH): string => {
	if (!Number.isInteger(dealId) || dealId <= 0) throw new Error('неверный ID сделки');
	return resolve(basePath, String(dealId));
};
const storedContractMetadataPath = (dealId: number, id: string, basePath = CONTRACT_DOCUMENTS_PATH): string =>
	resolve(storedContractDealDirectory(dealId, basePath), `${storedContractId(id)}.json`);
const storedContractFilePath = (dealId: number, id: string, basePath = CONTRACT_DOCUMENTS_PATH): string =>
	resolve(storedContractDealDirectory(dealId, basePath), `${storedContractId(id)}.docx`);

function parseStoredContractDocument(value: unknown, dealId: number): StoredDealContractDocument {
	const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const id = storedContractId(clean(row['id']));
	const storedDealId = Number(row['dealId']);
	if (storedDealId !== dealId) throw new Error('договор относится к другой сделке');
	const templateId = clean(row['templateId']);
	if (!CONTRACT_TEMPLATES.some((template) => template.id === templateId)) {
		throw new Error('неизвестный шаблон сохранённого договора');
	}
	return {
		id,
		dealId: storedDealId,
		contractNumber: clean(row['contractNumber']),
		templateId: templateId as ContractTemplateId,
		templateTitle: clean(row['templateTitle']),
		companyId: Number(row['companyId']),
		companyName: clean(row['companyName']),
		customerName: clean(row['customerName']),
		contractDate: clean(row['contractDate']),
		contractDateIso: clean(row['contractDateIso']),
		createdAt: clean(row['createdAt']),
		filename: clean(row['filename']),
		vatRate: Number(row['vatRate']) === 22 ? 22 : 5,
		total: Number(row['total']) || 0,
	};
}

export function contractFilenameFromCompanyName(
	templateId: ContractTemplateId,
	contractNumber: string,
	contractDateIso: string,
	companyName: string,
): string {
	const ipMatch = clean(companyName).match(/^ИП\s+([^\s.]+)/i);
	const shortCompanyName = (ipMatch ? `ИП ${ipMatch[1]}` : clean(companyName))
		.replace(/[«»"'“”„]/g, '')
		.replace(/[<>:/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const [year, month, day] = contractDateIso.split('-');
	const date = year && month && day ? `${day}.${month}.${year}` : contractDateIso;
	return `${CONTRACT_FILENAME_TITLES[templateId]} № ${contractNumber} от ${date} г. ${shortCompanyName}.docx`;
}

async function migrateStoredContractFilename(
	document: StoredDealContractDocument,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<StoredDealContractDocument> {
	const filename = contractFilenameFromCompanyName(
		document.templateId,
		document.contractNumber,
		document.contractDateIso,
		document.companyName,
	);
	if (document.filename === filename) return document;
	const migrated = { ...document, filename };
	const metadataPath = storedContractMetadataPath(document.dealId, document.id, basePath);
	const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
	await rename(temporaryPath, metadataPath);
	return migrated;
}

async function listStoredDealContractDocuments(
	dealId: number,
	basePath: string,
	migrateFilenames: boolean,
): Promise<StoredDealContractDocument[]> {
	const directory = storedContractDealDirectory(dealId, basePath);
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const documents = await Promise.all(entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map(async (entry): Promise<StoredDealContractDocument | null> => {
			try {
				const document = parseStoredContractDocument(
					JSON.parse(await readFile(resolve(directory, entry.name), 'utf8')),
					dealId,
				);
				return migrateFilenames ? migrateStoredContractFilename(document, basePath) : document;
			} catch {
				return null;
			}
		}));
	return documents
		.filter((document): document is StoredDealContractDocument => document != null)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listDealContractDocuments(
	dealId: number,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<StoredDealContractDocument[]> {
	if (contractSql.mode === 'off') return listStoredDealContractDocuments(dealId, basePath, true);
	const documents = await contractSql.read(String(dealId), () => listStoredDealContractDocuments(dealId, basePath, false));
	return documents.map(document => ({ ...document, filename: contractFilenameFromCompanyName(document.templateId, document.contractNumber, document.contractDateIso, document.companyName) })).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}

/** Административная диагностика не должна даже попутно переписывать метаданные договора. */
export async function listDealContractDocumentsReadOnly(
	dealId: number,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<StoredDealContractDocument[]> {
	return contractSql.read(String(dealId), () => listStoredDealContractDocuments(dealId, basePath, false));
}

export async function readDealContractDocument(
	dealId: number,
	id: string,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<{ document: StoredDealContractDocument; file: Buffer }> {
	if (contractSql.mode === 'primary') {
		storedContractId(id);
		const documents = await listDealContractDocuments(dealId,basePath);
		const document = documents.find(row => row.id === id);
		if (!document) throw new Error('Договор не найден');
		const file = await finishSqlContractFile(dealId,id,basePath);
		return { document, file };
	}
	const parsedDocument = parseStoredContractDocument(
		JSON.parse(await readFile(storedContractMetadataPath(dealId, id, basePath), 'utf8')),
		dealId,
	);
	const document = contractSql.mode === 'off'
		? await migrateStoredContractFilename(parsedDocument, basePath)
		: { ...parsedDocument, filename: contractFilenameFromCompanyName(parsedDocument.templateId, parsedDocument.contractNumber, parsedDocument.contractDateIso, parsedDocument.companyName) };
	const file = await readFile(storedContractFilePath(dealId, document.id, basePath));
	return { document, file };
}

export async function saveDealContractDocument(
	document: StoredDealContractDocument,
	file: Buffer,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<void> {
	if (contractSql.mode !== 'off') {
		const owner = String(document.dealId);
		const directory = storedContractDealDirectory(document.dealId,basePath);
		storedContractId(document.id);
		let stagingName = '';
		if (contractSql.mode === 'primary') {
			stagingName = `${document.id}.${randomUUID()}.pending.docx`;
			await mkdir(directory,{ recursive:true });
			await writeFile(resolve(directory,stagingName),file,{ flag:'wx', mode:0o600 });
		}
		await contractSql.mutate(owner, async () => {
			const documents = await contractSql.read(owner, () => listStoredDealContractDocuments(document.dealId,basePath,false));
			const existing = documents.find(row => row.id === document.id);
			if (existing && contentHash(existing) !== contentHash(document)) throw new Error('Договор с этим ID уже отличается');
			if (!existing) documents.push(document);
			documents.sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
			if (contractSql.mode === 'primary') {
				const c = contractSql.connection(owner);
				const previous = await c.query('SELECT deal_id,file_hash FROM app_contract_files WHERE document_id=?',[document.id]);
				if (previous.length && (Number(previous[0].deal_id) !== document.dealId || previous[0].file_hash !== fileHash(file))) throw new Error('Файл сохранённого договора уже отличается');
				if (!previous.length) await c.query('INSERT INTO app_contract_files(document_id,deal_id,file_hash,byte_length,staging_name,status) VALUES (?,?,?,?,?,\'pending\')',[document.id,document.dealId,fileHash(file),file.length,stagingName]);
			}
			await contractSql.write(owner,documents, async rows => {
				if (contractSql.mode === 'primary') {
					for (const row of rows) await finishSqlContractFile(row.dealId,row.id,basePath);
					await mirrorContractMetadata(rows,basePath);
				} else await saveLegacyContractDocument(document,file,basePath);
			});
		});
		if (contractSql.mode === 'primary') await finishSqlContractFile(document.dealId,document.id,basePath);
		return;
	}
	return saveLegacyContractDocument(document,file,basePath);
}

async function saveLegacyContractDocument(document: StoredDealContractDocument, file: Buffer, basePath: string): Promise<void> {
	const directory = storedContractDealDirectory(document.dealId, basePath);
	await mkdir(directory, { recursive: true });
	const filePath = storedContractFilePath(document.dealId, document.id, basePath);
	const metadataPath = storedContractMetadataPath(document.dealId, document.id, basePath);
	const temporaryFilePath = `${filePath}.${process.pid}.tmp`;
	const temporaryMetadataPath = `${metadataPath}.${process.pid}.tmp`;
	await writeFile(temporaryFilePath, file);
	await rename(temporaryFilePath, filePath);
	await writeFile(temporaryMetadataPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
	await rename(temporaryMetadataPath, metadataPath);
}

async function mirrorContractMetadata(documents: StoredDealContractDocument[], basePath: string) {
	for (const document of documents) {
		const metadata = storedContractMetadataPath(document.dealId,document.id,basePath);
		await mkdir(storedContractDealDirectory(document.dealId,basePath),{recursive:true});
		const temporary = `${metadata}.${randomUUID()}.tmp`;
		await writeFile(temporary,`${JSON.stringify(document,null,2)}\n`,{mode:0o600});
		await rename(temporary,metadata);
	}
}
export async function recoverContractMetadataMirror(dealId: number, basePath = CONTRACT_DOCUMENTS_PATH) {
	return contractSql.recover(String(dealId), async rows => {
		for (const document of rows) await finishSqlContractFile(dealId,document.id,basePath);
		await mirrorContractMetadata(rows,basePath);
	});
}
async function finishSqlContractFile(dealId: number, id: string, basePath: string): Promise<Buffer> {
	const active = contractSql.activeConnection(String(dealId));
	const c = active ?? await contractSql.runtime!.pool.getConnection();
	try {
		const manifests = await c.query('SELECT * FROM app_contract_files WHERE document_id=? AND deal_id=?',[id,dealId]);
		const manifest = manifests[0];
		if (!manifest) throw new Error('Отсутствует контрольная запись DOCX');
		const finalPath = storedContractFilePath(dealId,id,basePath);
		let file: Buffer;
		try { file = await readFile(finalPath); }
		catch (error) {
			if (!isNotFound(error) || manifest.status !== 'pending' || !/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.pending\.docx$/.test(manifest.staging_name)) throw error;
			const staging = resolve(storedContractDealDirectory(dealId,basePath),manifest.staging_name);
			const staged = await readFile(staging);
			if (fileHash(staged) !== manifest.file_hash || staged.length !== Number(manifest.byte_length)) throw new Error('Повреждён подготовленный DOCX');
			try { await rename(staging,finalPath); } catch (renameError) { if (!isNotFound(renameError)) throw renameError; }
			file = await readFile(finalPath);
		}
		if (fileHash(file) !== manifest.file_hash || file.length !== Number(manifest.byte_length)) throw new Error('Контрольная сумма DOCX не совпадает');
		if (manifest.status !== 'ready') await c.query('UPDATE app_contract_files SET status=\'ready\' WHERE document_id=? AND file_hash=?',[id,manifest.file_hash]);
		return file;
	} finally { if (!active) await c.release(); }
}
