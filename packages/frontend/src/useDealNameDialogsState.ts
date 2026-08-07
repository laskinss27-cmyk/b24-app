import { useState } from 'react';
import type { DealStageDialogState, DealVariantDialogState } from './DealNameDialogs.js';

export function useDealNameDialogsState() {
	const [variantDialog, setVariantDialog] = useState<DealVariantDialogState | null>(null);
	const [variantBusy, setVariantBusy] = useState(false);
	const [variantError, setVariantError] = useState<string | null>(null);
	const [stageDialog, setStageDialog] = useState<DealStageDialogState | null>(null);
	const [stageBusy, setStageBusy] = useState(false);
	const [stageError, setStageError] = useState<string | null>(null);
	return {
		variantDialog,
		setVariantDialog,
		variantBusy,
		setVariantBusy,
		variantError,
		setVariantError,
		stageDialog,
		setStageDialog,
		stageBusy,
		setStageBusy,
		stageError,
		setStageError,
	};
}
