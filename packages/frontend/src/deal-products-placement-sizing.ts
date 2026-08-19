export const PRODUCT_PICKER_MIN_HEIGHT = 900;
export const DEAL_WORKSPACE_MIN_HEIGHT = 821;
export const DEAL_PLACEMENT_VERTICAL_RESERVE = 219;
export const DEAL_CONTRACT_PREVIEW_MAX_HEIGHT = 760;
export const DEAL_DOCUMENT_PREVIEW_MARGIN = 12;

export const dealContractPreviewLayout = (
	anchorY: number,
	scrollY: number,
	viewportHeight: number,
): { top: number; height: number } => {
	const viewportTop = Math.max(DEAL_DOCUMENT_PREVIEW_MARGIN, Math.round(scrollY) + DEAL_DOCUMENT_PREVIEW_MARGIN);
	const viewportBottom = Math.max(viewportTop, Math.round(scrollY + viewportHeight) - DEAL_DOCUMENT_PREVIEW_MARGIN);
	const height = Math.min(DEAL_CONTRACT_PREVIEW_MAX_HEIGHT, Math.max(0, viewportBottom - viewportTop));
	const maximumTop = Math.max(viewportTop, viewportBottom - height);
	const preferredTop = Math.round(anchorY - height * 0.2);
	return {
		top: Math.min(maximumTop, Math.max(viewportTop, preferredTop)),
		height,
	};
};

export const dealWorkspaceFrameHeight = (
	currentFrameHeight: number,
	availableScreenHeight: number,
): number => Math.ceil(Math.max(
	currentFrameHeight,
	DEAL_WORKSPACE_MIN_HEIGHT,
	availableScreenHeight - DEAL_PLACEMENT_VERTICAL_RESERVE,
));

export const dealContentHeight = (minHeight = 0): number => {
	const root = document.getElementById('root');
	return Math.ceil(Math.max(
		minHeight,
		root?.scrollHeight ?? 0,
		document.body.scrollHeight,
		document.documentElement.scrollHeight,
	));
};

const dealFrameHeight = (): number => {
	const root = document.getElementById('root');
	if (!root?.classList.contains('deal-placement-root')) return dealContentHeight();
	return dealWorkspaceFrameHeight(
		Math.max(root.clientHeight, document.documentElement.clientHeight, window.innerHeight),
		window.outerHeight,
	);
};

export const requestB24FitWindow = (delay = 120): void => {
	window.setTimeout(() => {
		try {
			const bx24 = window.BX24;
			if (!bx24) return;
		bx24.resizeWindow(document.documentElement.clientWidth, dealFrameHeight());
		} catch { /* outside placement context */ }
	}, delay);
};
