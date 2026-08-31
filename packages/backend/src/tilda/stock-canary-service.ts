import { createHash } from 'node:crypto';
import { buildTildaCatalogCanaryXml, buildTildaOffersXml } from './commerce-ml.js';
import type { TildaCommerceMlExchangeResult } from './commerce-ml-client.js';
import type { TildaPublicStockRow } from './public-catalog.js';

interface TildaPreparedStockOffer {
	productId: number;
	tildaUid: string;
	externalId: string;
	sku: string;
	title: string;
	quantity: number;
	price?: number;
}

export interface TildaPreparedStockReport {
	generatedAt: string;
	publicCatalogContentHash: string;
	projectionOffers: TildaPreparedStockOffer[];
	rollbackOffers: TildaPreparedStockOffer[];
}

interface PublicCatalogState {
	parentCount: number;
	rows: TildaPublicStockRow[];
	contentHash: string;
}

export interface TildaStockCanaryResult {
	status: 'verified';
	tildaUid: string;
	externalId: string;
	sku: string;
	quantity: number;
	contentHashBefore: string;
	contentHashAfter: string;
	catalogXmlSha256: string;
	offersXmlSha256: string;
	protocol: TildaCommerceMlExchangeResult;
}

export async function runTildaStockCanary(
	input: { report: TildaPreparedStockReport; tildaUid: string; confirmation: string },
	dependencies: {
		readPublicCatalog: () => Promise<PublicCatalogState>;
		publishExchange: (catalogXml: string, offersXml: string) => Promise<TildaCommerceMlExchangeResult>;
		afterPublish?: () => Promise<void>;
	},
): Promise<TildaStockCanaryResult> {
	const projection = input.report.projectionOffers.find((offer) => offer.tildaUid === input.tildaUid);
	const rollback = input.report.rollbackOffers.find((offer) => offer.tildaUid === input.tildaUid);
	if (!projection || !rollback) throw new Error('Tilda canary UID is absent from the reversible projection');
	if (projection.externalId !== rollback.externalId || projection.sku !== rollback.sku || projection.quantity !== rollback.quantity) {
		throw new Error('Tilda canary quantity is not already equal in projection and rollback');
	}
	const expectedConfirmation = `canary:${projection.tildaUid}:${projection.quantity}:${input.report.publicCatalogContentHash}`;
	if (input.confirmation !== expectedConfirmation) throw new Error('Tilda canary confirmation does not match the prepared snapshot');

	const before = await dependencies.readPublicCatalog();
	const beforeRow = before.rows.find((row) => row.tildaUid === projection.tildaUid);
	if (before.parentCount !== 131 || before.rows.length !== 150 || before.contentHash !== input.report.publicCatalogContentHash) {
		throw new Error('Tilda public card content changed after preparation');
	}
	if (!beforeRow || beforeRow.sku !== projection.sku || beforeRow.quantity !== projection.quantity) {
		throw new Error('Tilda canary public identity or quantity changed after preparation');
	}

	const catalogXml = buildTildaCatalogCanaryXml(projection);
	const offersXml = buildTildaOffersXml([projection]);
	const protocol = await dependencies.publishExchange(catalogXml, offersXml);
	await dependencies.afterPublish?.();
	const after = await dependencies.readPublicCatalog();
	const afterRow = after.rows.find((row) => row.tildaUid === projection.tildaUid);
	if (after.parentCount !== before.parentCount || after.rows.length !== before.rows.length || after.contentHash !== before.contentHash) {
		throw new Error('Tilda card content changed during the stock canary');
	}
	if (!afterRow || afterRow.sku !== projection.sku || afterRow.quantity !== projection.quantity) {
		throw new Error('Tilda canary identity or quantity changed during verification');
	}

	return {
		status: 'verified',
		tildaUid: projection.tildaUid,
		externalId: projection.externalId,
		sku: projection.sku,
		quantity: projection.quantity,
		contentHashBefore: before.contentHash,
		contentHashAfter: after.contentHash,
		catalogXmlSha256: createHash('sha256').update(catalogXml).digest('hex'),
		offersXmlSha256: createHash('sha256').update(offersXml).digest('hex'),
		protocol,
	};
}
