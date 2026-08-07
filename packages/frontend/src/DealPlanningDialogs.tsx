import {
	DealStageNameDialog,
	DealVariantNameDialog,
	type DealStageDialogState,
	type DealVariantDialogState,
} from './DealNameDialogs.js';

export function DealPlanningDialogs({
	variantDialog,
	quoteVariantsEnabled,
	activeVariantName,
	variantBusy,
	variantError,
	onCloseVariant,
	onVariantValueChange,
	onSubmitVariant,
	stageDialog,
	stageBusy,
	stageError,
	onCloseStage,
	onStageValueChange,
	onSubmitStage,
}: {
	variantDialog: DealVariantDialogState | null;
	quoteVariantsEnabled: boolean;
	activeVariantName: string;
	variantBusy: boolean;
	variantError: string | null;
	onCloseVariant: () => void;
	onVariantValueChange: (value: string) => void;
	onSubmitVariant: () => void;
	stageDialog: DealStageDialogState | null;
	stageBusy: boolean;
	stageError: string | null;
	onCloseStage: () => void;
	onStageValueChange: (value: string) => void;
	onSubmitStage: () => void;
}): JSX.Element {
	return <>
		{variantDialog && (
			<DealVariantNameDialog
				dialog={variantDialog}
				quoteVariantsEnabled={quoteVariantsEnabled}
				activeVariantName={activeVariantName}
				busy={variantBusy}
				error={variantError}
				onClose={onCloseVariant}
				onValueChange={onVariantValueChange}
				onSubmit={onSubmitVariant}
			/>
		)}

		{stageDialog && (
			<DealStageNameDialog
				dialog={stageDialog}
				busy={stageBusy}
				error={stageError}
				onClose={onCloseStage}
				onValueChange={onStageValueChange}
				onSubmit={onSubmitStage}
			/>
		)}
	</>;
}
