export interface ExistingRepairDealSyncOperations {
	syncCore: () => Promise<number>;
	updateMetadata: () => Promise<void>;
	syncBitrixRows: (total: number) => Promise<void>;
}

export interface ExistingRepairDealSyncStatus {
	coreSynced: boolean;
	bitrixMetadataSynced: boolean;
	bitrixRowsSynced: boolean;
	coreError: unknown | null;
	bitrixMetadataError: unknown | null;
	bitrixRowsError: unknown | null;
}

/**
 * Ядро — источник истины состава сделки, поэтому обновляем его первым.
 * Ошибка Битрикс24 не должна отменять или блокировать синхронизацию ядра.
 */
export async function syncExistingRepairDealOperations(
	operations: ExistingRepairDealSyncOperations,
): Promise<ExistingRepairDealSyncStatus> {
	let total: number | null = null;
	let coreError: unknown | null = null;
	let bitrixMetadataError: unknown | null = null;
	let bitrixRowsError: unknown | null = null;

	try {
		total = await operations.syncCore();
	} catch (error) {
		coreError = error;
	}

	try {
		await operations.updateMetadata();
	} catch (error) {
		bitrixMetadataError = error;
	}

	if (total != null) {
		try {
			await operations.syncBitrixRows(total);
		} catch (error) {
			bitrixRowsError = error;
		}
	}

	return {
		coreSynced: coreError == null,
		bitrixMetadataSynced: bitrixMetadataError == null,
		bitrixRowsSynced: total != null && bitrixRowsError == null,
		coreError,
		bitrixMetadataError,
		bitrixRowsError,
	};
}

/** Поля существующей сделки: этап и направление менять запрещено. */
export function existingRepairDealFields(
	objectName: string,
	objectNameField: string,
): Record<string, unknown> {
	return {
		TITLE: objectName,
		[objectNameField]: objectName,
	};
}

export function repairDealSyncWarning(status: {
	coreSynced: boolean;
	bitrixMetadataSynced: boolean;
	bitrixRowsSynced: boolean;
}): string | null {
	if (!status.coreSynced) {
		return 'Ремонт сохранён, но состав сделки в ядре пока не обновился. Нажми «Синхронизировать сделку».';
	}
	if (!status.bitrixRowsSynced) {
		return 'Состав сделки в ядре обновлён, но сумма в Битрикс24 пока не обновилась. Нажми «Синхронизировать сделку».';
	}
	if (!status.bitrixMetadataSynced) {
		return 'Сумма сделки обновлена, но Битрикс24 не принял её название. Можно повторить синхронизацию позже.';
	}
	return null;
}
