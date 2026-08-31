import type { TildaPublicAvailabilityRow, TildaAvailability } from './public-catalog.js';
import type { TildaProductMapping, TildaStockOffer } from './stock-projection.js';

export interface TildaAvailabilityTarget {
	parentTildaUid: string;
	externalId: string;
	title: string;
	availability: TildaAvailability;
	currentAvailability: TildaAvailability | null;
	editionUids: string[];
}

export interface TildaAvailabilityProjection {
	targets: TildaAvailabilityTarget[];
	differences: TildaAvailabilityTarget[];
	skipped: Array<{
		parentTildaUid: string;
		reason: 'mapping_not_confirmed';
		statuses: string[];
	}>;
}

function parentUid(mapping: TildaProductMapping): string {
	if (mapping.rowKind === 'variant') {
		const parent = String(mapping.parentTildaUid ?? '').trim();
		if (!parent) throw new Error(`Tilda variant mapping ${mapping.tildaUid} has no parent UID`);
		return parent;
	}
	if (mapping.parentTildaUid) throw new Error(`Tilda parent mapping ${mapping.tildaUid} unexpectedly has a parent UID`);
	return mapping.tildaUid.trim();
}

function sortedUnique(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function buildTildaAvailabilityProjection(
	mappings: TildaProductMapping[],
	offers: TildaStockOffer[],
	publicRows: TildaPublicAvailabilityRow[],
): TildaAvailabilityProjection {
	const publicByParent = new Map(publicRows.map((row) => [row.tildaUid, row]));
	if (publicByParent.size !== publicRows.length) throw new Error('Tilda availability source has duplicate parent UIDs');
	const offersByUid = new Map(offers.map((offer) => [offer.tildaUid, offer]));
	if (offersByUid.size !== offers.length) throw new Error('Tilda stock projection has duplicate UIDs');
	const grouped = new Map<string, TildaProductMapping[]>();
	for (const mapping of mappings) {
		const parent = parentUid(mapping);
		grouped.set(parent, [...(grouped.get(parent) ?? []), mapping]);
	}

	const targets: TildaAvailabilityTarget[] = [];
	const skipped: TildaAvailabilityProjection['skipped'] = [];
	for (const [parentTildaUid, group] of grouped) {
		const statuses = sortedUnique(group.map((mapping) => mapping.status));
		if (statuses.length !== 1 || statuses[0] !== 'confirmed') {
			skipped.push({ parentTildaUid, reason: 'mapping_not_confirmed', statuses });
			continue;
		}
		const publicRow = publicByParent.get(parentTildaUid);
		if (!publicRow) throw new Error(`Tilda availability parent ${parentTildaUid} is absent from the public catalog`);
		const mappedEditionUids = sortedUnique(group.map((mapping) => mapping.tildaUid.trim()));
		const publicEditionUids = sortedUnique(publicRow.editionUids.map((uid) => uid.trim()));
		if (!sameStrings(mappedEditionUids, publicEditionUids)) {
			throw new Error(`Tilda availability parent ${parentTildaUid} has changed edition topology`);
		}
		const quantities = mappedEditionUids.map((uid) => {
			const offer = offersByUid.get(uid);
			if (!offer) throw new Error(`Tilda availability edition ${uid} has no complete Shelly stock projection`);
			return offer.quantity;
		});
		const availability: TildaAvailability = quantities.some((quantity) => quantity > 0) ? 'В наличии' : 'Под заказ';
		targets.push({
			parentTildaUid,
			externalId: publicRow.externalId,
			title: publicRow.title,
			availability,
			currentAvailability: publicRow.availability,
			editionUids: mappedEditionUids,
		});
	}

	targets.sort((left, right) => left.parentTildaUid.localeCompare(right.parentTildaUid));
	skipped.sort((left, right) => left.parentTildaUid.localeCompare(right.parentTildaUid));
	return {
		targets,
		differences: targets.filter((target) => target.availability !== target.currentAvailability),
		skipped,
	};
}
