import { createHash } from 'node:crypto';
import { buildTildaCatalogProductsXml, buildTildaOffersXml } from './commerce-ml.js';
import type { TildaCommerceMlExchangeResult } from './commerce-ml-client.js';
import type { TildaPublicStockRow } from './public-catalog.js';
import type { TildaPreparedStockReport } from './stock-canary-service.js';

export interface TildaPublicationReport extends TildaPreparedStockReport {
	fullProjectionHash: string;
	counts: {
		differences: number;
		publicParents: number;
		publicStockRows: number;
		reversibleProjectionOffers: number;
	};
}

export function selectTildaPublicationReport(report: TildaPublicationReport, onlyUid?: string): TildaPublicationReport {
	if (!onlyUid) return report;
	const projection = report.projectionOffers.find((offer) => offer.tildaUid === onlyUid);
	const rollback = report.rollbackOffers.find((offer) => offer.tildaUid === onlyUid);
	if (!projection || !rollback) throw new Error('selected Tilda publication UID is absent from the reversible snapshot');
	if (projection.quantity === rollback.quantity) throw new Error('selected Tilda publication UID is not a real stock change');
	return {
		...report,
		counts: { ...report.counts, differences: 1, reversibleProjectionOffers: 1 },
		projectionOffers: [projection],
		rollbackOffers: [rollback],
	};
}

interface PublicCatalogState {
	parentCount: number;
	rows: TildaPublicStockRow[];
	contentHash: string;
}

export interface TildaStockPublicationResult {
	status: 'verified';
	targetCount: number;
	changedCount: number;
	contentHashBefore: string;
	contentHashAfter: string;
	projectionHash: string;
	catalogXmlSha256: string;
	projectionXmlSha256: string;
	rollbackXmlSha256: string;
	protocol: TildaCommerceMlExchangeResult;
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function expectedConfirmation(report: TildaPublicationReport, changedCount: number): string {
	return `publish:${report.projectionOffers.length}:${changedCount}:${report.fullProjectionHash}:${report.publicCatalogContentHash}`;
}

function quantityMap(rows: TildaPublicStockRow[]): Map<string, TildaPublicStockRow> {
	return new Map(rows.map((row) => [row.tildaUid, row]));
}

function catalogMismatch(
	current: PublicCatalogState,
	baseline: PublicCatalogState,
	expectedTargets: Map<string, { sku: string; quantity: number }>,
): string | null {
	if (current.parentCount !== baseline.parentCount || current.rows.length !== baseline.rows.length) return 'public catalog counts changed';
	if (current.contentHash !== baseline.contentHash) return 'public card content hash changed';
	const currentByUid = quantityMap(current.rows);
	for (const baselineRow of baseline.rows) {
		const currentRow = currentByUid.get(baselineRow.tildaUid);
		if (!currentRow || currentRow.sku !== baselineRow.sku) return `public identity changed for UID ${baselineRow.tildaUid}`;
		const target = expectedTargets.get(baselineRow.tildaUid);
		const expectedQuantity = target?.quantity ?? baselineRow.quantity;
		if (target && target.sku !== currentRow.sku) return `projected SKU changed for UID ${baselineRow.tildaUid}`;
		if (currentRow.quantity !== expectedQuantity) return `quantity mismatch for UID ${baselineRow.tildaUid}`;
	}
	return null;
}

async function waitForCatalog(
	readPublicCatalog: () => Promise<PublicCatalogState>,
	wait: () => Promise<void>,
	baseline: PublicCatalogState,
	expectedTargets: Map<string, { sku: string; quantity: number }>,
): Promise<PublicCatalogState> {
	let lastMismatch = 'catalog was not checked';
	let consecutiveMatches = 0;
	for (let attempt = 0; attempt < 12; attempt += 1) {
		if (attempt > 0) await wait();
		const current = await readPublicCatalog();
		const mismatch = catalogMismatch(current, baseline, expectedTargets);
		if (!mismatch) {
			consecutiveMatches += 1;
			if (consecutiveMatches === 3) return current;
		} else {
			consecutiveMatches = 0;
			lastMismatch = mismatch;
		}
	}
	throw new Error(`Tilda public verification timed out before three stable reads: ${lastMismatch}`);
}

export async function runTildaStockPublication(
	input: { report: TildaPublicationReport; confirmation: string },
	dependencies: {
		readPublicCatalog: () => Promise<PublicCatalogState>;
		publishProjection: (catalogXml: string, offersXml: string) => Promise<TildaCommerceMlExchangeResult>;
		publishRollback: (catalogXml: string, offersXml: string) => Promise<TildaCommerceMlExchangeResult>;
		wait?: () => Promise<void>;
	},
): Promise<TildaStockPublicationResult> {
	const { report } = input;
	if (!Array.isArray(report.projectionOffers) || !Array.isArray(report.rollbackOffers)) throw new Error('Tilda publication report is incomplete');
	if (report.projectionOffers.length !== report.rollbackOffers.length || report.projectionOffers.length !== report.counts.reversibleProjectionOffers) {
		throw new Error('Tilda publication target counts do not match');
	}
	if (report.counts.publicParents !== 131 || report.counts.publicStockRows !== 150 || report.projectionOffers.length < 1) {
		throw new Error('Tilda publication counts differ from the audited baseline');
	}

	const rollbackByUid = new Map(report.rollbackOffers.map((offer) => [offer.tildaUid, offer]));
	const seenUids = new Set<string>();
	const seenExternalIds = new Set<string>();
	let changedCount = 0;
	for (const projection of report.projectionOffers) {
		const rollback = rollbackByUid.get(projection.tildaUid);
		if (!rollback || rollback.externalId !== projection.externalId || rollback.sku !== projection.sku || rollback.title !== projection.title) {
			throw new Error(`Tilda rollback identity mismatch for UID ${projection.tildaUid}`);
		}
		if (seenUids.has(projection.tildaUid) || seenExternalIds.has(projection.externalId)) throw new Error('Tilda publication contains duplicate identities');
		seenUids.add(projection.tildaUid);
		seenExternalIds.add(projection.externalId);
		if (projection.quantity !== rollback.quantity) changedCount += 1;
	}
	if (changedCount !== report.counts.differences) throw new Error('Tilda publication difference count is inconsistent');
	if (input.confirmation !== expectedConfirmation(report, changedCount)) throw new Error('Tilda publication confirmation does not match the fresh snapshot');

	const before = await dependencies.readPublicCatalog();
	if (before.parentCount !== report.counts.publicParents || before.rows.length !== report.counts.publicStockRows || before.contentHash !== report.publicCatalogContentHash) {
		throw new Error('Tilda public catalog changed after publication preparation');
	}
	const beforeByUid = quantityMap(before.rows);
	for (const rollback of report.rollbackOffers) {
		const current = beforeByUid.get(rollback.tildaUid);
		if (!current || current.sku !== rollback.sku || current.quantity !== rollback.quantity) {
			throw new Error(`Tilda rollback snapshot is stale for UID ${rollback.tildaUid}`);
		}
	}

	const catalogXml = buildTildaCatalogProductsXml(report.projectionOffers);
	const projectionXml = buildTildaOffersXml(report.projectionOffers);
	const rollbackXml = buildTildaOffersXml(report.rollbackOffers);
	const projectedTargets = new Map(report.projectionOffers.map((offer) => [offer.tildaUid, { sku: offer.sku, quantity: offer.quantity }]));
	const rollbackTargets = new Map(report.rollbackOffers.map((offer) => [offer.tildaUid, { sku: offer.sku, quantity: offer.quantity }]));
	const wait = dependencies.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 5_000)));

	let protocol: TildaCommerceMlExchangeResult;
	try {
		protocol = await dependencies.publishProjection(catalogXml, projectionXml);
		const after = await waitForCatalog(dependencies.readPublicCatalog, wait, before, projectedTargets);
		const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
		return {
			status: 'verified',
			targetCount: report.projectionOffers.length,
			changedCount,
			contentHashBefore: before.contentHash,
			contentHashAfter: after.contentHash,
			projectionHash: report.fullProjectionHash,
			catalogXmlSha256: sha256(catalogXml),
			projectionXmlSha256: sha256(projectionXml),
			rollbackXmlSha256: sha256(rollbackXml),
			protocol,
		};
	} catch (publicationError) {
		try {
			await dependencies.publishRollback(catalogXml, rollbackXml);
			await waitForCatalog(dependencies.readPublicCatalog, wait, before, rollbackTargets);
		} catch (rollbackError) {
			throw new Error(`Tilda publication failed (${errorMessage(publicationError)}); rollback failed (${errorMessage(rollbackError)})`);
		}
		throw new Error(`Tilda publication failed and verified rollback was applied: ${errorMessage(publicationError)}`);
	}
}
