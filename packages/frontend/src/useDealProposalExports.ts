import { useState } from 'react';
import { downloadDealKpDocx, downloadDealXlsx } from './b24.js';

type ExportNotice = { kind: 'ok' | 'err'; text: string } | null;

export function useDealProposalExports({
	dealId,
	variantId,
	dev,
	onNotice,
}: {
	dealId: number | null;
	variantId: string | undefined;
	dev: boolean;
	onNotice: (notice: ExportNotice) => void;
}): {
	exportBusy: boolean;
	exportXlsx: () => Promise<void>;
	exportDocx: () => Promise<void>;
} {
	const [exportBusy, setExportBusy] = useState(false);

	const exportXlsx = async (): Promise<void> => {
		if (dealId == null || exportBusy) return;
		setExportBusy(true);
		onNotice(null);
		try {
			await downloadDealXlsx(dealId, variantId);
			onNotice({ kind: 'ok', text: '✅ КП в Excel сформировано и скачано.' });
		} catch (error) {
			onNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setExportBusy(false);
		}
	};

	const exportDocx = async (): Promise<void> => {
		if (dealId == null || exportBusy || dev) return;
		setExportBusy(true);
		onNotice(null);
		try {
			await downloadDealKpDocx(dealId, variantId);
			onNotice({ kind: 'ok', text: '✅ КП в Word сформировано и скачано.' });
		} catch (error) {
			onNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setExportBusy(false);
		}
	};

	return { exportBusy, exportXlsx, exportDocx };
}
