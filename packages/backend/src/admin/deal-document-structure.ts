import type { ErpClient } from '../erp/client.js';
import { DEAL_FIELD } from '../erp/erp-setup.js';
import type { DiagnosticIssue } from './repair-diagnostics-model.js';
import type { AdminDealDocument } from './deal-document-diagnostics.js';
import type { AdminDealApplicationDocuments } from './deal-application-documents.js';

export type DealDocumentLinkStatus = 'linked' | 'wrong_deal' | 'missing' | 'unreadable';

export interface DealDocumentStructureLink {
	fromType: string;
	fromName: string;
	relation: string;
	targetType: AdminDealDocument['type'];
	targetName: string;
	status: DealDocumentLinkStatus;
	targetDealId: number | null;
	details: string;
}

export interface DealDocumentStructureReport {
	status: 'ok' | 'warning' | 'error';
	checkedLinkCount: number;
	brokenLinkCount: number;
	links: DealDocumentStructureLink[];
}

interface LinkCandidate {
	fromType: string;
	fromName: string;
	relation: string;
	targetType: AdminDealDocument['type'];
	targetName: string;
}

function documentKey(type: AdminDealDocument['type'], name: string): string {
	return `${type}\u0000${name}`;
}

function addCandidate(target: LinkCandidate[], candidate: LinkCandidate): void {
	if (!candidate.targetName) return;
	const key = `${candidate.fromType}\u0000${candidate.fromName}\u0000${candidate.relation}\u0000${candidate.targetType}\u0000${candidate.targetName}`;
	if (!target.some((item) => `${item.fromType}\u0000${item.fromName}\u0000${item.relation}\u0000${item.targetType}\u0000${item.targetName}` === key)) target.push(candidate);
}

function documentCandidates(documents: AdminDealDocument[]): LinkCandidate[] {
	const result: LinkCandidate[] = [];
	for (const document of documents) {
		if (document.amendedFrom) addCandidate(result, { fromType: document.label, fromName: document.name, relation: 'исправляет документ', targetType: document.type, targetName: document.amendedFrom });
		if (document.returnAgainst) addCandidate(result, { fromType: document.label, fromName: document.name, relation: 'возвращает реализацию', targetType: 'Delivery Note', targetName: document.returnAgainst });
		if (document.supplyRequest) addCandidate(result, { fromType: document.label, fromName: document.name, relation: 'создан по заявке', targetType: 'Material Request', targetName: document.supplyRequest });
		if (document.purchaseOrder) addCandidate(result, { fromType: document.label, fromName: document.name, relation: 'создан по заказу поставщику', targetType: 'Purchase Order', targetName: document.purchaseOrder });
		for (const item of document.items) {
			if (item.againstSalesOrder) addCandidate(result, { fromType: document.label, fromName: document.name, relation: 'отгружает план сделки', targetType: 'Sales Order', targetName: item.againstSalesOrder });
		}
	}
	return result;
}

function transferCandidates(applicationDocuments: AdminDealApplicationDocuments): LinkCandidate[] {
	const result: LinkCandidate[] = [];
	for (const transfer of applicationDocuments.transfers) {
		const from = transfer.name || `Перемещение #${transfer.id}`;
		if (transfer.supplyRequest && !transfer.supplyRequestKey.startsWith('transfer-request:')) addCandidate(result, { fromType: 'Перемещение приложения', fromName: from, relation: 'создано по заявке', targetType: 'Material Request', targetName: transfer.supplyRequest });
		if (transfer.purchaseOrder) addCandidate(result, { fromType: 'Перемещение приложения', fromName: from, relation: 'создано по заказу поставщику', targetType: 'Purchase Order', targetName: transfer.purchaseOrder });
		if (transfer.shipEntry) addCandidate(result, { fromType: 'Перемещение приложения', fromName: from, relation: 'отправлено документом ядра', targetType: 'Stock Entry', targetName: transfer.shipEntry });
		if (transfer.receiveEntry) addCandidate(result, { fromType: 'Перемещение приложения', fromName: from, relation: 'принято документом ядра', targetType: 'Stock Entry', targetName: transfer.receiveEntry });
	}
	return result;
}

function targetDealId(raw: Record<string, unknown>): number | null {
	const value = Number(raw[DEAL_FIELD]);
	return Number.isInteger(value) && value > 0 ? value : null;
}

async function inspectLink(erp: ErpClient, dealId: number, loaded: Set<string>, candidate: LinkCandidate): Promise<DealDocumentStructureLink> {
	if (loaded.has(documentKey(candidate.targetType, candidate.targetName))) {
		return { ...candidate, status: 'linked', targetDealId: dealId, details: 'Документ найден в цепочке этой сделки.' };
	}
	try {
		const target = await erp.get<Record<string, unknown>>(candidate.targetType, candidate.targetName);
		if (!target) return { ...candidate, status: 'missing', targetDealId: null, details: 'Указанный документ не существует в ядре.' };
		const linkedDealId = targetDealId(target);
		if (linkedDealId === dealId) return { ...candidate, status: 'linked', targetDealId: linkedDealId, details: 'Документ существует и привязан к этой сделке.' };
		return {
			...candidate,
			status: 'wrong_deal',
			targetDealId: linkedDealId,
			details: linkedDealId ? `Документ привязан к другой сделке #${linkedDealId}.` : 'Документ существует, но не привязан к сделке.',
		};
	} catch (error) {
		return { ...candidate, status: 'unreadable', targetDealId: null, details: `Не удалось проверить документ: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function linkIssue(link: DealDocumentStructureLink, index: number): DiagnosticIssue | null {
	if (link.status === 'linked') return null;
	const source = `${link.fromType} ${link.fromName}`;
	const target = `${link.targetType} ${link.targetName}`;
	if (link.status === 'missing') return { code: `structure_missing_${index}`, severity: 'error', title: 'Связанный документ не найден', details: `${source} ссылается на ${target}. ${link.details}` };
	if (link.status === 'wrong_deal') return { code: `structure_wrong_deal_${index}`, severity: 'warning', title: 'Документ выпал из цепочки сделки', details: `${source} ссылается на ${target}. ${link.details}` };
	return { code: `structure_unreadable_${index}`, severity: 'warning', title: 'Связь документов не удалось проверить', details: `${source} → ${target}. ${link.details}` };
}

export async function inspectDealDocumentStructure(
	erp: ErpClient,
	dealId: number,
	documents: AdminDealDocument[],
	applicationDocuments: AdminDealApplicationDocuments,
): Promise<{ report: DealDocumentStructureReport; issues: DiagnosticIssue[] }> {
	const loaded = new Set(documents.map((document) => documentKey(document.type, document.name)));
	const candidates = [...documentCandidates(documents), ...transferCandidates(applicationDocuments)];
	const links = await Promise.all(candidates.map((candidate) => inspectLink(erp, dealId, loaded, candidate)));
	const issues = links.flatMap((link, index) => {
		const issue = linkIssue(link, index);
		return issue ? [issue] : [];
	});
	const brokenLinkCount = links.filter((link) => link.status !== 'linked').length;
	const status = links.some((link) => link.status === 'missing') ? 'error' : brokenLinkCount ? 'warning' : 'ok';
	return { report: { status, checkedLinkCount: links.length, brokenLinkCount, links }, issues };
}
