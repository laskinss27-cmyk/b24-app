import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CONTRACT_FILENAME_TITLES, CONTRACT_TEMPLATES } from './deal-contract-templates.js';
import type { ContractTemplateId, StoredDealContractDocument } from './deal-contract-types.js';

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

export async function listDealContractDocuments(
	dealId: number,
	basePath = CONTRACT_DOCUMENTS_PATH,
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
				return migrateStoredContractFilename(document, basePath);
			} catch {
				return null;
			}
		}));
	return documents
		.filter((document): document is StoredDealContractDocument => document != null)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readDealContractDocument(
	dealId: number,
	id: string,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<{ document: StoredDealContractDocument; file: Buffer }> {
	const parsedDocument = parseStoredContractDocument(
		JSON.parse(await readFile(storedContractMetadataPath(dealId, id, basePath), 'utf8')),
		dealId,
	);
	const document = await migrateStoredContractFilename(parsedDocument, basePath);
	const file = await readFile(storedContractFilePath(dealId, document.id, basePath));
	return { document, file };
}

export async function saveDealContractDocument(
	document: StoredDealContractDocument,
	file: Buffer,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<void> {
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
