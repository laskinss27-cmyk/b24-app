// Local fixture, excluded from the production entry. API calls are mocked by the UI test.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DealDocumentMenu } from './DealDocumentMenu.js';
import { KpDocument, type DealPrintKind } from './Kp.js';
import { useDealProposalExports } from './useDealProposalExports.js';
import './global.css';
import './deal-products.css';
import './deal-documents.css';
import './print.css';
import './dark-theme.css';
import './dark-theme.generated.css';

window.__B24_CONTEXT__ = { domain: 'fixture.invalid', accessToken: 'fixture', dealId: 501, memberId: null };
function Preview(): JSX.Element {
	const [print, setPrint] = useState<{ kind: DealPrintKind; withoutModels: boolean } | null>(null);
	const [notice, setNotice] = useState<{ text: string } | null>(null);
	const { exportBusy, exportDocx, exportXlsx } = useDealProposalExports({ dealId: 501, variantId: 'alternative-a', dev: false, onNotice: setNotice });
	if (print) return <KpDocument dealId={501} variantId="alternative-a" mock={false} kind={print.kind} withoutModels={print.withoutModels} onBack={() => setPrint(null)} />;
	return <main className="deal-products-tab"><h1>Проверка печати КП</h1><p>Локальные тестовые данные</p>
		<div className="deal-actions"><DealDocumentMenu exportBusy={exportBusy} dealAvailable workingMode dev={false}
			onExportWord={(value) => void exportDocx(value)} onExportExcel={(value) => void exportXlsx(value)}
			onPrintProposal={(value) => setPrint({ kind: 'kp', withoutModels: value })}
			onPrintReceipt={() => setPrint({ kind: 'receipt', withoutModels: false })}
			onOpenContract={() => setNotice({ text: 'Открыт договор' })} /></div>
		{notice && <p role="status">{notice.text}</p>}
	</main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
