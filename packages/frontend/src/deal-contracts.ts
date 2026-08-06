import { bx24Auth } from './bitrix-auth.js';

export interface ContractPartyInfo {
	id: number;
	entityTypeId: 3 | 4;
	title: string;
	kind: 'company' | 'ip' | 'person';
	fullName: string;
	shortName: string;
	director: string;
	email: string;
	missing: string[];
}

export type ContractTemplateId = 'universal_work' | 'supply' | 'design' | 'smart_home';
export type ContractPartyKind = 'company' | 'ip' | 'person';
export type ContractDurationUnit = 'calendar' | 'working';

export interface ContractTemplateInfo {
	id: ContractTemplateId;
	title: string;
	available: boolean;
	ourRole: string;
	customerRole: string;
	usesObjectAddress: boolean;
	usesObjectName: boolean;
	usesWorkDuration: boolean;
}

export interface DealContractContext {
	dealId: number;
	dealTitle: string;
	ownCompanies: ContractPartyInfo[];
	selectedCompanyId: number | null;
	customer: ContractPartyInfo | null;
	customerMissingByKind: Record<ContractPartyKind, string[]>;
	objectAddress: string;
	contractNumber: string;
	contractDate: string;
	vatRate: 5 | 22;
	templates: ContractTemplateInfo[];
	selectedTemplateId: ContractTemplateId;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}

export interface StoredDealContractDocument {
	id: string;
	dealId: number;
	contractNumber: string;
	templateId: ContractTemplateId;
	templateTitle: string;
	companyId: number;
	companyName: string;
	customerName: string;
	contractDate: string;
	contractDateIso: string;
	createdAt: string;
	filename: string;
	vatRate: 5 | 22;
	total: number;
}

export async function fetchDealContractContext(dealId: number): Promise<DealContractContext> {
	const res = await fetch('/api/contracts/context', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; context?: DealContractContext };
	if (!json.ok || !json.context) throw new Error(json.error ?? 'не удалось подготовить договор');
	return json.context;
}

export async function fetchDealContracts(dealId: number): Promise<StoredDealContractDocument[]> {
	const res = await fetch('/api/contracts/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; documents?: StoredDealContractDocument[] };
	if (!json.ok || !json.documents) throw new Error(json.error ?? 'не удалось загрузить договоры сделки');
	return json.documents;
}

export async function createDealContract(input: {
	dealId: number;
	companyId: number;
	templateId: ContractTemplateId;
	customerKind: ContractPartyKind;
	contractDate: string;
	objectAddress: string;
	objectName: string;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}): Promise<StoredDealContractDocument> {
	const res = await fetch('/api/contracts/generate', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; document?: StoredDealContractDocument };
	if (!res.ok || !json.ok || !json.document) {
		throw new Error(json.error ?? `не удалось сформировать договор (HTTP ${res.status})`);
	}
	return json.document;
}

export async function fetchDealContractFile(dealId: number, documentId: string): Promise<Blob> {
	const res = await fetch('/api/contracts/file', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, documentId }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
		let message = `не удалось открыть договор (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	return res.blob();
}

export async function downloadStoredDealContract(contract: StoredDealContractDocument): Promise<void> {
	const blob = await fetchDealContractFile(contract.dealId, contract.id);
	const url = URL.createObjectURL(blob);
	try {
		const link = globalThis.document.createElement('a');
		link.href = url;
		link.download = contract.filename;
		globalThis.document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
