import { renameDealStage } from './b24.js';
import type { DealStageDialogState } from './DealNameDialogs.js';

export function createDealStageActions({
	dealId,
	stageDialog,
	stageBusy,
	onStage,
	onReload,
	setStageDialog,
	setStageBusy,
	setStageError,
}: {
	dealId: number | null;
	stageDialog: DealStageDialogState | null;
	stageBusy: boolean;
	onStage: (stageName: string) => void;
	onReload: () => Promise<void>;
	setStageDialog: (dialog: DealStageDialogState | null) => void;
	setStageBusy: (busy: boolean) => void;
	setStageError: (error: string | null) => void;
}): { submitStageDialog: () => Promise<void> } {
	const submitStageDialog = async (): Promise<void> => {
		if (!stageDialog || stageBusy) return;
		const name = stageDialog.value.trim();
		if (!name) { setStageError('Укажи название этапа.'); return; }
		if (stageDialog.kind === 'create') {
			setStageDialog(null);
			onStage(name);
			return;
		}
		if (dealId == null || !stageDialog.stageId) return;
		setStageBusy(true); setStageError(null);
		try {
			await renameDealStage(dealId, stageDialog.stageId, name);
			setStageDialog(null);
			await onReload();
		} catch (error) { setStageError(String(error instanceof Error ? error.message : error)); }
		finally { setStageBusy(false); }
	};

	return { submitStageDialog };
}
