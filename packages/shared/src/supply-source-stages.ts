/** Snapshot of the deal sections selected when the supply request was created. */
export interface SupplySourceStage { id: string; name: string }

export function parseSupplySourceStages(value: unknown): SupplySourceStage[] {
	let raw = value;
	if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return []; } }
	if (!Array.isArray(raw)) return [];
	const unique = new Map<string, SupplySourceStage>();
	for (const item of raw) {
		if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
		const id = item.id.trim(); const name = item.name.replace(/\s+/g, ' ').trim();
		if (id && name && !unique.has(id)) unique.set(id, { id, name });
	}
	return [...unique.values()];
}

export function supplySourceStagesLabel(stages: readonly SupplySourceStage[] | undefined): string {
	const names = parseSupplySourceStages(stages).map((stage) => stage.name);
	return names.length ? `${names.length === 1 ? 'Этап заказа' : 'Этапы заказа'}: ${names.join(', ')}` : '';
}

export function withSupplySourceStages(title: string, stages: readonly SupplySourceStage[] | undefined): string {
	const label = supplySourceStagesLabel(stages);
	return label ? `${title} · ${label}` : title;
}
