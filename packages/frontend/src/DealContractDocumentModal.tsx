import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { renderAsync as renderDocx } from 'docx-preview';
import { downloadStoredDealContract, fetchDealContractFile, type StoredDealContractDocument } from './b24.js';
import { rub } from './deal-display-formatters.js';

export function DealContractDocumentModal({
	preview,
	onClose,
}: {
	preview: { document: StoredDealContractDocument; anchorY: number };
	onClose: () => void;
}): JSX.Element {
	const hostRef = useRef<HTMLDivElement>(null);
	const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const previewHeight = Math.min(900, Math.max(520, window.screen.availHeight - 100));
	const overlayStyle: CSSProperties = {
		top: Math.max(12, Math.round(preview.anchorY - previewHeight * 0.2)),
		height: previewHeight,
	};

	useEffect(() => {
		globalThis.document.body.classList.add('deal-contract-preview-open');
		return () => globalThis.document.body.classList.remove('deal-contract-preview-open');
	}, []);

	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', closeOnEscape);
		return () => window.removeEventListener('keydown', closeOnEscape);
	}, [onClose]);

	useEffect(() => {
		let alive = true;
		const host = hostRef.current;
		if (!host) return;
		host.replaceChildren();
		setPhase('loading');
		setError(null);
		void fetchDealContractFile(preview.document.dealId, preview.document.id)
			.then(async (blob) => {
				if (!alive) return;
				await renderDocx(blob, host, undefined, {
					inWrapper: true,
					hideWrapperOnPrint: false,
					ignoreWidth: false,
					ignoreHeight: false,
					breakPages: true,
					renderHeaders: true,
					renderFooters: true,
					useBase64URL: true,
				});
				if (alive) setPhase('ready');
			})
			.catch((reason) => {
				if (!alive) return;
				setError(String(reason instanceof Error ? reason.message : reason));
				setPhase('error');
			});
		return () => {
			alive = false;
			host.replaceChildren();
		};
	}, [preview.document.dealId, preview.document.id]);

	const save = async (): Promise<void> => {
		if (saving) return;
		setSaving(true);
		try {
			await downloadStoredDealContract(preview.document);
		} catch (reason) {
			setError(String(reason instanceof Error ? reason.message : reason));
		} finally {
			setSaving(false);
		}
	};

	const document = preview.document;
	return (
		<div className="deal-document-preview-overlay deal-contract-preview-overlay" style={overlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<section className="deal-document-preview deal-contract-preview" role="dialog" aria-modal="true" aria-label={`Договор № ${document.contractNumber}`}>
				<header>
					<div><span>{document.templateTitle}</span><h2>Договор № {document.contractNumber}</h2></div>
					<button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button>
				</header>
				<div className="deal-document-preview-facts">
					<div><span>Дата</span><b>{document.contractDate}</b></div>
					<div><span>Наша компания</span><b>{document.companyName}</b></div>
					<div><span>Заказчик</span><b>{document.customerName}</b></div>
					<div><span>Сумма</span><b>{rub(document.total)}</b></div>
				</div>
				<div className="deal-contract-preview-body">
					{phase === 'loading' && <p className="deal-contract-preview-message">Открываю договор…</p>}
					{phase === 'error' && <p className="deal-contract-preview-message error">{error ?? 'Не удалось открыть договор.'}</p>}
					<div ref={hostRef} className="deal-contract-docx" aria-busy={phase === 'loading'} />
				</div>
				<footer>
					<button type="button" className="btn-secondary" disabled={saving} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Скачать Word'}</button>
					<button type="button" className="btn-secondary" disabled={phase !== 'ready'} onClick={() => window.print()}>Печать</button>
					<button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
				</footer>
			</section>
		</div>
	);
}
