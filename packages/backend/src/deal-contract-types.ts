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

type Address = Record<string, unknown>;
type Requisite = Record<string, unknown>;
type BankDetail = Record<string, unknown>;

export interface ContractParty {
	id: number;
	entityTypeId: 3 | 4;
	title: string;
	kind: ContractPartyKind;
	fullName: string;
	shortName: string;
	director: string;
	email: string;
	nameParts: {
		last: string;
		first: string;
		patronymic: string;
	};
	requisite: Requisite | null;
	address: Address | null;
	bank: BankDetail | null;
	certificate: string;
	missing: string[];
}

export interface ContractContext {
	dealId: number;
	dealTitle: string;
	ownCompanies: ContractParty[];
	selectedCompanyId: number | null;
	customer: ContractParty | null;
	customerMissingByKind: Record<ContractPartyKind, string[]>;
	objectAddress: string;
	contractNumber: string;
	contractDate: string;
	vatRate: 5 | 22;
	templates: readonly ContractTemplateInfo[];
	selectedTemplateId: ContractTemplateId;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}

export interface ContractGenerateInput {
	companyId: number;
	templateId: ContractTemplateId;
	customerKind: ContractPartyKind;
	contractDate: string;
	objectAddress: string;
	objectName: string;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}

export interface ContractLine {
	name: string;
	price: number;
	quantity: number;
	total: number;
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
