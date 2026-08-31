import { createHash } from 'node:crypto';
import { buildTildaAvailabilityCatalogXml, buildTildaOffersXml } from './commerce-ml.js';
import type { TildaCommerceMlExchangeResult } from './commerce-ml-client.js';
import type { TildaPublicAvailabilityRow, TildaPublicStockRow } from './public-catalog.js';
import type { TildaAvailabilityTarget } from './availability-projection.js';
import type { TildaStockOffer } from './stock-projection.js';

export interface TildaPreparedAvailabilityReport {
	generatedAt: string;
	propertyId: string;
	fullProjectionHash: string;
	publicCatalogContentHash: string;
	counts: {
		publicParents: number;
		publicStockRows: number;
		targets: number;
		differences: number;
		skippedGroups: number;
	};
	targets: TildaAvailabilityTarget[];
	anchorOffer: TildaStockOffer;
}

interface PublicCatalogState {
	parentCount: number;
	rows: TildaPublicStockRow[];
	availabilityRows: TildaPublicAvailabilityRow[];
	availabilityProtectedContentHash: string;
}

export interface TildaAvailabilityPublicationResult {
	status: 'verified';
	targetCount: number;
	changedCount: number;
	contentHashBefore: string;
	contentHashAfter: string;
	catalogXmlSha256: string;
	rollbackXmlSha256: string;
	offersXmlSha256: string;
	protocol: TildaCommerceMlExchangeResult;
}

export function selectTildaAvailabilityReport(
	report: TildaPreparedAvailabilityReport,
	parentTildaUid?: string,
): TildaPreparedAvailabilityReport {
	if (!parentTildaUid) return report;
	const target = report.targets.find((row) => row.parentTildaUid === parentTildaUid);
	if (!target) throw new Error('selected Tilda availability parent UID is absent from the prepared report');
	return {
		...report,
		counts: {
			...report.counts,
			targets: 1,
			differences: Number(target.availability !== target.currentAvailability),
		},
		targets: [target],
	};
}

function expectedConfirmation(report: TildaPreparedAvailabilityReport): string {
	return `availability:${report.targets.length}:${report.counts.differences}:${report.fullProjectionHash}:${report.publicCatalogContentHash}`;
}

function sameStrings(left: string[], right: string[]): boolean {
	const a = [...left].sort((x, y) => x.localeCompare(y));
	const b = [...right].sort((x, y) => x.localeCompare(y));
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function catalogMismatch(
	current: PublicCatalogState,
	baseline: PublicCatalogState,
	expected: ReadonlyMap<string, string | null>,
): string | null {
	if (current.parentCount !== baseline.parentCount || current.rows.length !== baseline.rows.length
		|| current.availabilityRows.length !== baseline.availabilityRows.length) return 'public catalog counts changed';
	if (current.availabilityProtectedContentHash !== baseline.availabilityProtectedContentHash) return 'protected card content hash changed';
	const currentStock = new Map(current.rows.map((row) => [row.tildaUid, row]));
	for (const row of baseline.rows) {
		const candidate = currentStock.get(row.tildaUid);
		if (!candidate || candidate.sku !== row.sku || candidate.quantity !== row.quantity || candidate.price !== row.price) {
			return `stock or price changed for UID ${row.tildaUid}`;
		}
	}
	const currentAvailability = new Map(current.availabilityRows.map((row) => [row.tildaUid, row]));
	for (const row of baseline.availabilityRows) {
		const candidate = currentAvailability.get(row.tildaUid);
		if (!candidate || candidate.externalId !== row.externalId || candidate.title !== row.title
			|| !sameStrings(candidate.editionUids, row.editionUids)) return `parent identity changed for UID ${row.tildaUid}`;
		if (candidate.availability !== (expected.get(row.tildaUid) ?? row.availability)) {
			return `availability mismatch for UID ${row.tildaUid}`;
		}
	}
	return null;
}

async function waitForCatalog(
	readPublicCatalog: () => Promise<PublicCatalogState>,
	wait: () => Promise<void>,
	baseline: PublicCatalogState,
	expected: ReadonlyMap<string, string | null>,
): Promise<PublicCatalogState> {
	let lastMismatch = 'catalog was not checked';
	let consecutiveMatches = 0;
	for (let attempt = 0; attempt < 12; attempt += 1) {
		if (attempt > 0) await wait();
		const current = await readPublicCatalog();
		const mismatch = catalogMismatch(current, baseline, expected);
		if (!mismatch) {
			consecutiveMatches += 1;
			if (consecutiveMatches === 3) return current;
		} else {
			consecutiveMatches = 0;
			lastMismatch = mismatch;
		}
	}
	throw new Error(`Tilda availability verification timed out before three stable reads: ${lastMismatch}`);
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export async function runTildaAvailabilityPublication(
	input: { report: TildaPreparedAvailabilityReport; confirmation: string },
	dependencies: {
		readPublicCatalog: () => Promise<PublicCatalogState>;
		publishProjection: (catalogXml: string, offersXml: string) => Promise<TildaCommerceMlExchangeResult>;
		publishRollback: (catalogXml: string, offersXml: string) => Promise<TildaCommerceMlExchangeResult>;
		wait?: () => Promise<void>;
	},
): Promise<TildaAvailabilityPublicationResult> {
	const { report } = input;
	if (!report.propertyId.trim() || report.targets.length !== report.counts.targets || report.targets.length < 1) {
		throw new Error('Tilda availability publication report is incomplete');
	}
	if (report.counts.publicParents !== 131 || report.counts.publicStockRows !== 150 || report.counts.skippedGroups !== 14) {
		throw new Error('Tilda availability counts differ from the audited baseline');
	}
	const changedCount = report.targets.filter((target) => target.availability !== target.currentAvailability).length;
	if (changedCount !== report.counts.differences) throw new Error('Tilda availability difference count is inconsistent');
	if (input.confirmation !== expectedConfirmation(report)) throw new Error('Tilda availability confirmation does not match the prepared snapshot');
	if (new Set(report.targets.map((target) => target.parentTildaUid)).size !== report.targets.length) {
		throw new Error('Tilda availability publication has duplicate parent UIDs');
	}

	const before = await dependencies.readPublicCatalog();
	if (before.parentCount !== report.counts.publicParents || before.rows.length !== report.counts.publicStockRows
		|| before.availabilityProtectedContentHash !== report.publicCatalogContentHash) {
		throw new Error('Tilda public catalog changed after availability preparation');
	}
	const beforeParents = new Map(before.availabilityRows.map((row) => [row.tildaUid, row]));
	for (const target of report.targets) {
		const current = beforeParents.get(target.parentTildaUid);
		if (!current || current.externalId !== target.externalId || current.title !== target.title
			|| current.availability !== target.currentAvailability || !sameStrings(current.editionUids, target.editionUids)) {
			throw new Error(`Tilda availability rollback snapshot is stale for UID ${target.parentTildaUid}`);
		}
	}
	const beforeAnchor = before.rows.find((row) => row.tildaUid === report.anchorOffer.tildaUid);
	if (!beforeAnchor || beforeAnchor.sku !== report.anchorOffer.sku || beforeAnchor.quantity !== report.anchorOffer.quantity) {
		throw new Error('Tilda availability no-op offers anchor is stale');
	}

	const catalogXml = buildTildaAvailabilityCatalogXml(report.targets.map((target) => ({
		externalId: target.externalId,
		title: target.title,
		availability: target.availability,
	})), report.propertyId);
	const rollbackXml = buildTildaAvailabilityCatalogXml(report.targets.map((target) => {
		if (!target.currentAvailability) throw new Error(`Tilda availability UID ${target.parentTildaUid} has no reversible current value`);
		return { externalId: target.externalId, title: target.title, availability: target.currentAvailability };
	}), report.propertyId);
	const { price: _anchorPrice, ...anchorWithoutPrice } = report.anchorOffer;
	const offersXml = buildTildaOffersXml([anchorWithoutPrice]);
	const projected = new Map(report.targets.map((target) => [target.parentTildaUid, target.availability]));
	const rollback = new Map(report.targets.map((target) => [target.parentTildaUid, target.currentAvailability]));
	const wait = dependencies.wait ?? (() => new Promise((resolve) => setTimeout(resolve, 5_000)));

	let protocol: TildaCommerceMlExchangeResult;
	try {
		protocol = await dependencies.publishProjection(catalogXml, offersXml);
		const after = await waitForCatalog(dependencies.readPublicCatalog, wait, before, projected);
		const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
		return {
			status: 'verified',
			targetCount: report.targets.length,
			changedCount,
			contentHashBefore: before.availabilityProtectedContentHash,
			contentHashAfter: after.availabilityProtectedContentHash,
			catalogXmlSha256: sha256(catalogXml),
			rollbackXmlSha256: sha256(rollbackXml),
			offersXmlSha256: sha256(offersXml),
			protocol,
		};
	} catch (publicationError) {
		try {
			await dependencies.publishRollback(rollbackXml, offersXml);
			await waitForCatalog(dependencies.readPublicCatalog, wait, before, rollback);
		} catch (rollbackError) {
			throw new Error(`Tilda availability publication failed (${errorMessage(publicationError)}); rollback failed (${errorMessage(rollbackError)})`);
		}
		throw new Error(`Tilda availability publication failed and verified rollback was applied: ${errorMessage(publicationError)}`);
	}
}
