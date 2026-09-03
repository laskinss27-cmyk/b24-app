import type { TildaProductMapping } from './stock-projection.js';
import type { TildaPublicStockRow } from './public-catalog.js';
import { compareTildaPublicStock } from './public-stock-comparison.js';
import { prepareTildaStockPreview } from './stock-preview-service.js';
import { runTildaStockPublication, type TildaPublicationReport, type TildaStockPublicationResult } from './stock-publish-service.js';
import type { TildaCommerceMlExchangeResult } from './commerce-ml-client.js';
import type { TildaStockSyncRunStore, TildaSyncTrigger } from './stock-sync-run-store.js';

interface PublicCatalogState {
	parentCount: number;
	rows: TildaPublicStockRow[];
	contentHash: string;
	protectedContentHash?: string;
}

export interface TildaStockReconciliationDependencies {
	readMappings(): Promise<TildaProductMapping[]>;
	fetchStocks(productIds: number[]): Promise<Map<number, Record<string, number>>>;
	fetchReservations(productIds: number[], sourceStore: string): Promise<Map<number, number>>;
	fetchPrices?(productIds: number[]): Promise<Map<number, number>>;
	readPublicCatalog(): Promise<PublicCatalogState>;
	publishProjection(catalogXml: string, offersXml: string): Promise<TildaCommerceMlExchangeResult>;
	publishRollback(catalogXml: string, offersXml: string): Promise<TildaCommerceMlExchangeResult>;
	audit: Pick<TildaStockSyncRunStore,
		'recordPreparationFailure' | 'recordNoopIfChanged' | 'start' | 'finishVerified' | 'finishFailed'>;
	wait?: () => Promise<void>;
	now?: () => Date;
}

export type TildaStockReconciliationResult =
	| {
		status: 'no_op'; targetCount: number; priceTargetCount?: number; priceDifferenceCount?: number;
		missingErpPriceCount?: number; blockedMissingPublicPriceCount?: number;
		auditWritten: boolean; projectionHash: string; contentHash: string;
	}
	| TildaStockPublicationResult;

const EXPECTED_UNLIMITED_UIDS = new Set(['124782539723', '708983630233']);

function validateAuditedShape(input: {
	mappings: TildaProductMapping[];
	offerCount: number;
	skippedCount: number;
	publicCatalog: PublicCatalogState;
	projectionCount: number;
	rollbackCount: number;
	blockedUids: string[];
}): void {
	if (
		input.mappings.length !== 162 || input.offerCount !== 146 || input.skippedCount !== 16
		|| input.publicCatalog.parentCount !== 143 || input.publicCatalog.rows.length !== 162
		|| input.projectionCount !== 144 || input.rollbackCount !== 144
	) throw new Error('Tilda reconciliation counts differ from the audited baseline');
	if (
		input.blockedUids.length !== EXPECTED_UNLIMITED_UIDS.size
		|| input.blockedUids.some((uid) => !EXPECTED_UNLIMITED_UIDS.has(uid))
	) throw new Error('Tilda unlimited-stock exclusions differ from the audited baseline');
}

export async function runTildaStockReconciliation(
	trigger: TildaSyncTrigger,
	dependencies: TildaStockReconciliationDependencies,
): Promise<TildaStockReconciliationResult> {
	let runUuid: string | null = null;
	try {
		const mappings = await dependencies.readMappings();
		const preview = await prepareTildaStockPreview({
			readMappings: async () => mappings,
			fetchStocks: dependencies.fetchStocks,
			fetchReservations: dependencies.fetchReservations,
			...(dependencies.fetchPrices ? { fetchPrices: dependencies.fetchPrices } : {}),
		}, undefined, dependencies.now?.() ?? new Date());
		const publicCatalog = await dependencies.readPublicCatalog();
		const contentHash = preview.priceSyncEnabled
			? publicCatalog.protectedContentHash
			: publicCatalog.contentHash;
		if (!contentHash) throw new Error('Tilda public catalog has no required protected content hash');
		const comparison = compareTildaPublicStock(mappings, preview.offers, publicCatalog.rows);
		validateAuditedShape({
			mappings,
			offerCount: preview.offers.length,
			skippedCount: preview.skippedCount,
			publicCatalog,
			projectionCount: comparison.projectionOffers.length,
			rollbackCount: comparison.rollbackOffers.length,
			blockedUids: comparison.blockedUnlimited.map(({ tildaUid }) => tildaUid),
		});
		const metrics = {
			projectionHash: preview.projectionHash,
			contentHashBefore: contentHash,
			targetCount: comparison.projectionOffers.length,
			differenceCountBefore: comparison.differences.length + comparison.priceDifferences.length,
			blockedCount: comparison.blockedUnlimited.length + comparison.blockedMissingPrice.length + preview.missingPriceCount,
		};
		if (metrics.differenceCountBefore === 0) {
			const auditWritten = await dependencies.audit.recordNoopIfChanged(trigger, metrics);
			return {
				status: 'no_op',
				targetCount: metrics.targetCount,
				...(preview.priceSyncEnabled ? {
					priceTargetCount: comparison.projectionOffers.filter((offer) => offer.price !== undefined).length,
					priceDifferenceCount: comparison.priceDifferences.length,
					missingErpPriceCount: preview.missingPriceCount,
					blockedMissingPublicPriceCount: comparison.blockedMissingPrice.length,
				} : {}),
				auditWritten,
				projectionHash: metrics.projectionHash,
				contentHash: metrics.contentHashBefore,
			};
		}

		runUuid = await dependencies.audit.start(trigger, metrics);
		const report: TildaPublicationReport = {
			generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
			publicCatalogContentHash: contentHash,
			fullProjectionHash: preview.projectionHash,
			...(preview.priceSyncEnabled ? { priceSyncEnabled: true } : {}),
			counts: {
				differences: metrics.differenceCountBefore,
				publicParents: publicCatalog.parentCount,
				publicStockRows: publicCatalog.rows.length,
				reversibleProjectionOffers: comparison.projectionOffers.length,
				...(preview.priceSyncEnabled ? {
					priceTargets: comparison.projectionOffers.filter((offer) => offer.price !== undefined).length,
					priceDifferences: comparison.priceDifferences.length,
					blockedMissingPrices: comparison.blockedMissingPrice.length,
					missingErpPrices: preview.missingPriceCount,
				} : {}),
			},
			projectionOffers: comparison.projectionOffers,
			rollbackOffers: comparison.rollbackOffers,
		};
		const confirmation = `publish:${report.projectionOffers.length}:${report.counts.differences}:${report.fullProjectionHash}:${report.publicCatalogContentHash}`;
		try {
			const result = await runTildaStockPublication({ report, confirmation }, {
				readPublicCatalog: dependencies.readPublicCatalog,
				publishProjection: dependencies.publishProjection,
				publishRollback: dependencies.publishRollback,
				...(dependencies.wait ? { wait: dependencies.wait } : {}),
			});
			await dependencies.audit.finishVerified(runUuid, {
				contentHashAfter: result.contentHashAfter,
				differenceCountAfter: 0,
				catalogXmlHash: result.catalogXmlSha256,
				projectionXmlHash: result.projectionXmlSha256,
				rollbackXmlHash: result.rollbackXmlSha256,
			});
			return result;
		} catch (error) {
			await dependencies.audit.finishFailed(runUuid, 'publish', error);
			throw error;
		}
	} catch (error) {
		if (!runUuid) await dependencies.audit.recordPreparationFailure(trigger, error);
		throw error;
	}
}
