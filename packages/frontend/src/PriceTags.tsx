import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import type { BaseRow } from './b24.js';

const QR_URL = 'https://dom-automation.ru';
const SETTINGS_KEY = 'b24-price-tag-settings-v1';

export type PriceTagSize = '60x40' | '90x65';

export interface PriceTagSelection {
	row: BaseRow;
	copies: number;
}

interface PriceTagSettings {
	tagSize: PriceTagSize;
	companyName: string;
	showArticle: boolean;
	showModel: boolean;
	nameSizePt: number;
	qrSizeMm: number;
}

interface PriceTagDraft extends PriceTagSelection {
	price: number;
}

const DEFAULT_SETTINGS: PriceTagSettings = {
	tagSize: '60x40',
	companyName: 'Умный Дом',
	showArticle: true,
	showModel: true,
	nameSizePt: 8,
	qrSizeMm: 12,
};

const SIZES = {
	'60x40': { width: 60, height: 40, columns: 3, rows: 6, priceFont: 22, currencyFont: 7, articleFont: 6, companyFont: 6.5, bottomHeight: 4 },
	'90x65': { width: 90, height: 65, columns: 2, rows: 4, priceFont: 32, currencyFont: 9, articleFont: 7.5, companyFont: 8, bottomHeight: 5 },
} as const;

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPrice(value: number): string {
	return Math.max(0, Math.round(value || 0)).toLocaleString('ru-RU');
}

function loadSettings(): PriceTagSettings {
	try {
		const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<PriceTagSettings> | null;
		return saved ? { ...DEFAULT_SETTINGS, ...saved } : DEFAULT_SETTINGS;
	} catch {
		return DEFAULT_SETTINGS;
	}
}

function expandDrafts(items: PriceTagDraft[]): PriceTagDraft[] {
	return items.flatMap((item) => Array.from({ length: Math.max(1, Math.floor(item.copies || 1)) }, () => item));
}

function buildPriceTagsHtml(items: PriceTagDraft[], settings: PriceTagSettings, qrDataUrl: string): string {
	const size = SIZES[settings.tagSize];
	const isLarge = settings.tagSize === '90x65';
	const perPage = size.columns * size.rows;
	const expanded = expandDrafts(items);
	const pages: PriceTagDraft[][] = [];
	for (let i = 0; i < expanded.length; i += perPage) pages.push(expanded.slice(i, i + perPage));
	if (!pages.length) pages.push([]);
	const qrSize = settings.qrSizeMm;
	const modelSize = Math.max(5.5, settings.nameSizePt - 1.5);

	const tag = (item: PriceTagDraft): string => {
		const article = settings.showArticle ? (item.row.article ?? '') : '';
		const model = settings.showModel ? (item.row.model ?? '') : '';
		return `<div class="tag">
			<div class="tag-top">
				<div class="article">${article ? `Арт: ${escapeHtml(article)}` : ''}</div>
				<div class="name">${escapeHtml(item.row.name)}</div>
				${model && model !== article ? `<div class="model">${escapeHtml(model)}</div>` : ''}
			</div>
			<div class="tag-middle">
				<img class="qr" src="${qrDataUrl}" alt="" />
				<div class="price"><strong>${formatPrice(item.price)}</strong><span>руб.</span></div>
			</div>
			<div class="company">${escapeHtml(settings.companyName || 'Умный Дом')}</div>
		</div>`;
	};
	const page = (chunk: PriceTagDraft[]): string => {
		const empty = Array.from({ length: perPage - chunk.length }, () => '<div class="tag empty"></div>');
		return `<section class="page">${[...chunk.map(tag), ...empty].join('')}</section>`;
	};

	return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ценники</title><style>
		@page { size: A4 portrait; margin: 0; }
		* { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: Arial, "Segoe UI", sans-serif; }
		.page { width: 210mm; height: 297mm; padding: 10mm; display: grid; grid-template-columns: repeat(${size.columns}, ${size.width}mm); grid-template-rows: repeat(${size.rows}, ${size.height}mm); gap: 3mm; page-break-after: always; }
		.page:last-child { page-break-after: auto; }
		.tag { width: ${size.width}mm; height: ${size.height}mm; border: .3mm solid #bbb; border-radius: 1.5mm; padding: ${isLarge ? '3mm 3.5mm' : '2mm 2.5mm'}; display: grid; grid-template-rows: minmax(0, 1fr) auto ${size.bottomHeight}mm; overflow: hidden; }
		.tag.empty { border: .3mm dashed #eee; }
		.tag-top { display: block; min-height: 0; overflow: hidden; }
		.article { min-height: ${isLarge ? '3mm' : '2.4mm'}; color: #777; font-size: ${size.articleFont}pt; }
		.name { overflow: hidden; overflow-wrap: anywhere; color: #111; font-size: ${settings.nameSizePt}pt; font-weight: 700; line-height: 1.15; }
		.model { margin-top: .5mm; overflow: hidden; color: #666; font-size: ${modelSize}pt; text-overflow: ellipsis; white-space: nowrap; }
		.tag-middle { display: grid; grid-template-columns: ${qrSize}mm 1fr; align-items: center; gap: ${isLarge ? '3mm' : '2mm'}; padding: ${isLarge ? '2mm' : '1.5mm'} 0; border-top: .2mm solid #eee; border-bottom: .2mm solid #eee; }
		.qr { display: block; width: ${qrSize}mm; height: ${qrSize}mm; }
		.price { display: flex; align-items: baseline; justify-content: flex-end; gap: 1.5mm; white-space: nowrap; }
		.price strong { font-size: ${size.priceFont}pt; font-variant-numeric: tabular-nums; line-height: 1; }
		.price span { color: #444; font-size: ${size.currencyFont}pt; }
		.company { padding-top: 1mm; color: #555; font-size: ${size.companyFont}pt; text-align: center; }
	</style></head><body>${pages.map(page).join('')}</body></html>`;
}

function NumberDraft({ value, min = 0, onChange, className = '' }: { value: number; min?: number; onChange: (value: number) => void; className?: string }): JSX.Element {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	return <input className={className} type="number" min={min} value={text} onFocus={(event) => event.currentTarget.select()} onChange={(event) => {
		setText(event.target.value);
		if (event.target.value === '') return;
		const next = Number(event.target.value);
		if (Number.isFinite(next)) onChange(Math.max(min, next));
	}} onBlur={() => setText(String(value))} />;
}

export function PriceTagsModal({ items, onClose }: { items: PriceTagSelection[]; onClose: () => void }): JSX.Element {
	const [settings, setSettings] = useState<PriceTagSettings>(loadSettings);
	const [drafts, setDrafts] = useState<PriceTagDraft[]>(() => items.map((item) => ({ ...item, price: item.row.retail ?? 0 })));
	const [qrDataUrl, setQrDataUrl] = useState('');

	useEffect(() => {
		void QRCode.toDataURL(QR_URL, { margin: 0, width: 256, errorCorrectionLevel: 'M' }).then(setQrDataUrl);
	}, []);
	useEffect(() => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }, [settings]);

	const html = useMemo(() => qrDataUrl ? buildPriceTagsHtml(drafts, settings, qrDataUrl) : '', [drafts, settings, qrDataUrl]);
	const totalCopies = drafts.reduce((sum, item) => sum + item.copies, 0);
	const update = (id: number, patch: Partial<PriceTagDraft>): void => setDrafts((current) => current.map((item) => item.row.id === id ? { ...item, ...patch } : item));
	const remove = (id: number): void => setDrafts((current) => current.filter((item) => item.row.id !== id));

	function print(): void {
		if (!html || !drafts.length) return;
		const popup = window.open('', '_blank');
		if (!popup) { window.alert('Браузер заблокировал окно печати. Разрешите всплывающие окна для приложения.'); return; }
		popup.document.open();
		popup.document.write(html);
		popup.document.close();
		popup.focus();
		window.setTimeout(() => popup.print(), 250);
	}

	return <div className="price-tags-overlay" onClick={onClose}>
		<div className="price-tags-modal" onClick={(event) => event.stopPropagation()}>
			<header>
				<div><h2>Ценники</h2><p>{drafts.length} поз. · {totalCopies} ценник(а)</p></div>
				<button className="price-tags-close" type="button" onClick={onClose} aria-label="Закрыть">×</button>
			</header>
			<div className="price-tags-body">
				<section className="price-tags-editor">
					<div className="price-tags-settings">
						<label>Формат<select value={settings.tagSize} onChange={(event) => setSettings((value) => ({ ...value, tagSize: event.target.value as PriceTagSize }))}><option value="60x40">60 × 40 мм</option><option value="90x65">90 × 65 мм</option></select></label>
						<label>Компания<input value={settings.companyName} onChange={(event) => setSettings((value) => ({ ...value, companyName: event.target.value }))} /></label>
						<label className="price-tags-check"><input type="checkbox" checked={settings.showArticle} onChange={(event) => setSettings((value) => ({ ...value, showArticle: event.target.checked }))} /> Артикул</label>
						<label className="price-tags-check"><input type="checkbox" checked={settings.showModel} onChange={(event) => setSettings((value) => ({ ...value, showModel: event.target.checked }))} /> Модель</label>
					</div>
					<div className="price-tags-size-settings">
						<label><span>Шрифт названия <b>{settings.nameSizePt} пт</b></span><input type="range" min="6" max="18" step="0.5" value={settings.nameSizePt} onChange={(event) => setSettings((value) => ({ ...value, nameSizePt: Number(event.target.value) }))} /></label>
						<label><span>Размер QR <b>{settings.qrSizeMm} мм</b></span><input type="range" min="8" max="24" step="1" value={settings.qrSizeMm} onChange={(event) => setSettings((value) => ({ ...value, qrSizeMm: Number(event.target.value) }))} /></label>
					</div>
					<div className="price-tags-list-head"><span>Товар</span><span>Цена</span><span>Штук</span><span /></div>
					<div className="price-tags-list">
						{drafts.map((item) => <div className="price-tags-item" key={item.row.id}>
							<div><strong>{item.row.name}</strong><small>{item.row.article ?? item.row.model ?? `#${item.row.id}`}</small></div>
							<NumberDraft className="price-tags-number" value={item.price} onChange={(price) => update(item.row.id, { price })} />
							<NumberDraft className="price-tags-number copies" value={item.copies} min={1} onChange={(copies) => update(item.row.id, { copies: Math.max(1, Math.floor(copies)) })} />
							<button type="button" className="price-tags-remove" onClick={() => remove(item.row.id)} aria-label="Убрать">×</button>
						</div>)}
						{!drafts.length && <div className="price-tags-empty">Все позиции убраны.</div>}
					</div>
				</section>
				<aside className="price-tags-preview">
					<div className="price-tags-preview-title">Предпросмотр A4</div>
					<div className="price-tags-sheet">{html && <iframe title="Предпросмотр ценников" srcDoc={html} />}</div>
					<small>QR ведет на {QR_URL.replace('https://', '')}</small>
				</aside>
			</div>
			<footer>
				<span>В окне печати можно выбрать принтер или «Сохранить как PDF».</span>
				<button className="btn-secondary" type="button" onClick={onClose}>Закрыть</button>
				<button className="btn-primary" type="button" disabled={!drafts.length || !html} onClick={print}>Печать / PDF</button>
			</footer>
		</div>
	</div>;
}
