export { CONTRACT_TEMPLATES } from './deal-contract-templates.js';
export {
	listDealContractDocuments,
	readDealContractDocument,
	saveDealContractDocument,
} from './deal-contract-storage.js';
export {
	allocatePersistentContractNumber,
	contractNumberStartByInn,
} from './deal-contract-numbering.js';
export { contractLinesFromB24ProductRows, contractLinesFromPlan } from './deal-contract-lines.js';
export { contractDateText, contractWorkDuration } from './deal-contract-text.js';
export { buildContractDocx } from './deal-contract-docx.js';
export { getContractContext } from './deal-contract-bitrix.js';
export { generateDealContract } from './deal-contract-generator.js';
export {
	contractFilename,
	contractObjectAddress,
	contractPartyAsKind,
	contractVatRate,
} from './deal-contract-parties.js';
export type {
	ContractContext,
	ContractDurationUnit,
	ContractGenerateInput,
	ContractLine,
	ContractParty,
	ContractPartyKind,
	ContractTemplateId,
	ContractTemplateInfo,
	StoredDealContractDocument,
} from './deal-contract-types.js';
