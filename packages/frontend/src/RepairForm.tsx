import { useEffect, useState } from 'react';
import {
	fetchStores,
	findRepairContactByPhone,
	searchRepairContacts,
	uploadRepairFile,
	type NewRepairInput,
	type Repair,
	type RepairContact,
	type RepairFile,
	type RepairPhoto,
	type StoreInfo,
} from './b24.js';

/** Фото → ужатый data-URL (хранится в нашем store; Диск Б24 недоступен — нет scope). */
async function fileToPhoto(file: File, maxPx = 1280, quality = 0.7): Promise<RepairPhoto> {
	const url = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('не прочитать файл'));
		reader.onload = () => {
			const img = new Image();
			img.onerror = () => reject(new Error('не картинка'));
			img.onload = () => {
				const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
				const w = Math.max(1, Math.round(img.width * scale));
				const h = Math.max(1, Math.round(img.height * scale));
				const canvas = document.createElement('canvas');
				canvas.width = w; canvas.height = h;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('canvas')); return; }
				ctx.drawImage(img, 0, 0, w, h);
				resolve(canvas.toDataURL('image/jpeg', quality));
			};
			img.src = String(reader.result ?? '');
		};
		reader.readAsDataURL(file);
	});
	return { id: 0, name: file.name, url };
}


export function RepairForm({ mock, canEditPrice, initial, onCancel, submit, onDone }: {
	mock: boolean;
	canEditPrice: boolean;
	initial?: Repair | undefined;
	onCancel: () => void;
	submit: (input: NewRepairInput) => Promise<Repair>;
	onDone: (r: Repair) => Promise<void>;
}): JSX.Element {
	const isEdit = Boolean(initial);
	const [clientName, setClientName] = useState(initial?.client.name ?? '');
	const [clientPhone, setClientPhone] = useState(initial?.client.phone ?? '');
	const [contactId, setContactId] = useState<number | null>(initial?.client.contactId ?? null);
	const [results, setResults] = useState<RepairContact[]>([]);
	const [phoneMatch, setPhoneMatch] = useState<RepairContact | null>(null);
	const [device, setDevice] = useState(initial?.device ?? '');
	const [model, setModel] = useState(initial?.model ?? '');
	const [serial, setSerial] = useState(initial?.serial ?? '');
	const [point, setPoint] = useState(initial?.point ?? '');
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [appearance, setAppearance] = useState(initial?.appearance ?? '');
	const [defect, setDefect] = useState(initial?.defect ?? '');
	const [internalComment, setInternalComment] = useState(initial?.internalComment ?? '');
	const [comment, setComment] = useState(initial?.comment ?? '');
	const [payType, setPayType] = useState<'warranty' | 'paid'>(initial?.payType ?? 'warranty');
	const [cost, setCost] = useState<string>(initial?.cost != null ? String(initial.cost) : '');
	const [ourPrice, setOurPrice] = useState<string>(initial?.ourPrice != null ? String(initial.ourPrice) : '');
	const [photos, setPhotos] = useState<RepairPhoto[]>(initial?.photos ?? []);
	const [files, setFiles] = useState<RepairFile[]>(initial?.files ?? []);
	const [uploading, setUploading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [formErr, setFormErr] = useState<string | null>(null);
	const [pointMissing, setPointMissing] = useState(false);

	useEffect(() => { fetchStores().then((s) => setStores(s.filter((x) => x.active))).catch(() => setStores([])); }, []);

	async function searchContacts(v: string): Promise<void> {
		setClientName(v);
		setContactId(null);
		if (mock || v.trim().length < 2) { setResults([]); return; }
		try { setResults(await searchRepairContacts(v)); } catch { setResults([]); }
	}
	function pickContact(c: RepairContact): void {
		setClientName(c.name); setClientPhone(c.phone); setContactId(c.id); setResults([]); setPhoneMatch(null);
	}
	function changePoint(value: string): void {
		setPoint(value);
		if (value.trim()) {
			setPointMissing(false);
			if (formErr === 'Выбери склад приёмки — без него ремонт сохранить нельзя.') setFormErr(null);
		}
	}
	/** Проактивный подбор по номеру: при уходе из поля телефона ищем занявший его контакт и показываем плашку. */
	async function checkPhone(): Promise<void> {
		if (mock || contactId || clientPhone.trim().length < 4) { setPhoneMatch(null); return; }
		try { setPhoneMatch(await findRepairContactByPhone(clientPhone.trim())); } catch { /* молча — подстрахует сабмит */ }
	}

	/** Одна кнопка на всё: изображения → превью (data-URL), документы Word/Excel/PDF → Диск Б24 (ссылка). */
	async function onAttach(fl: FileList | null): Promise<void> {
		if (!fl || !fl.length) return;
		setUploading(true); setFormErr(null);
		try {
			for (const f of Array.from(fl)) {
				if (f.type.startsWith('image/')) {
					try { const photo = await fileToPhoto(f); setPhotos((p) => [...p, photo]); }
					catch { setFormErr('Не удалось обработать фото (ремонт можно сохранить без него).'); }
				} else if (mock) {
					setFiles((p) => [...p, { id: 0, name: f.name, url: '#', type: f.type }]);
				} else {
					try {
						const up = await uploadRepairFile(f);
						if (up) setFiles((p) => [...p, up]);
						else setFormErr('Не удалось загрузить документ на Диск (ремонт можно сохранить без него).');
					} catch { setFormErr('Не удалось загрузить документ на Диск (ремонт можно сохранить без него).'); }
				}
			}
		} finally { setUploading(false); }
	}

	async function onSubmit(): Promise<void> {
		if (!clientName.trim()) { setFormErr('Клиент обязателен — выбери из базы или впиши ФИО (новый создастся в Б24).'); return; }
		if (!contactId && !clientPhone.trim()) { setFormErr('Укажи телефон клиента — по нему найдём существующего или заведём нового в Б24.'); return; }
		if (!point.trim()) {
			setPointMissing(true);
			setFormErr('Выбери склад приёмки — без него ремонт сохранить нельзя.');
			return;
		}
		// Контроль дублей: номер занят существующим контактом — спрашиваем приёмщика ДО сохранения,
		// чтобы ремонт не повис молча на чужом контакте (Б24 всё равно не создаст дубль по номеру).
		if (!contactId && !mock && clientPhone.trim()) {
			const found = await findRepairContactByPhone(clientPhone.trim()).catch(() => null);
			if (found) { setPhoneMatch(found); setFormErr(null); return; }
		}
		setSaving(true); setFormErr(null);
		try {
			const input: NewRepairInput = {
				client: { contactId, name: clientName.trim(), phone: clientPhone.trim() },
				device: device.trim(), model: model.trim(), serial: serial.trim(), point: point.trim(),
				appearance: appearance.trim(), defect: defect.trim(), internalComment: internalComment.trim(), comment: comment.trim(), payType,
				cost: payType === 'paid' && cost.trim() !== '' && Number.isFinite(Number(cost)) ? Number(cost) : null,
				ourPrice: payType === 'paid' && ourPrice.trim() !== '' && Number.isFinite(Number(ourPrice)) ? Number(ourPrice) : null,
				photos, files,
			};
			const r = await submit(input);
			await onDone(r);
		} catch (e: unknown) {
			setFormErr(String(e instanceof Error ? e.message : e));
		} finally { setSaving(false); }
	}

	return (
		<div className="repair-form">
			<div className="base-backbar"><button className="btn-secondary" onClick={onCancel}>{isEdit ? '← К ремонту' : '← К списку'}</button></div>
			<h2>{isEdit ? `Редактировать ремонт #${initial!.id}` : 'Принять в ремонт'}</h2>

			<div className="rf-grid">
				<label className="rf-field rf-wide">Клиент (ФИО / организация)
					<input type="text" value={clientName} placeholder="начните вводить — поиск по контактам" onChange={(e) => void searchContacts(e.target.value)} />
					{results.length > 0 && (
						<div className="rf-suggest">
							{results.map((c) => (
								<button key={c.id} type="button" className="rf-suggest-item" onClick={() => pickContact(c)}>
									{c.name}{c.phone && <span className="muted small"> · {c.phone}</span>}
								</button>
							))}
						</div>
					)}
					{contactId
						? <span className="muted small">✓ контакт Б24 #{contactId}</span>
						: clientName.trim() ? <span className="muted small">＋ новый клиент — создастся в Б24 с телефоном</span> : null}
				</label>
				<label className="rf-field">Телефон
					<input type="text" value={clientPhone} placeholder="+7 …" onChange={(e) => { setClientPhone(e.target.value); setPhoneMatch(null); }} onBlur={() => void checkPhone()} />
				</label>
				{phoneMatch && (
					<div className="rf-phone-match" style={{ gridColumn: '1 / -1' }}>
						📞 По номеру <b>{phoneMatch.phone || clientPhone}</b> уже есть контакт: <b>{phoneMatch.name}</b>. Это он?
						<div className="rf-phone-match-actions">
							<button type="button" className="btn-secondary" onClick={() => pickContact(phoneMatch)}>Да, это клиент</button>
							<button type="button" className="btn-secondary" onClick={() => setPhoneMatch(null)}>Другой — исправлю номер</button>
						</div>
					</div>
				)}

				<label className="rf-field">Оборудование
					<input type="text" value={device} placeholder="видеодомофон, контроллер…" onChange={(e) => setDevice(e.target.value)} />
				</label>
				<label className="rf-field">Модель
					<input type="text" value={model} placeholder="CTV-M5702" onChange={(e) => setModel(e.target.value)} />
				</label>
				<label className="rf-field">Серийный №
					<input type="text" value={serial} placeholder="с корпуса устройства" onChange={(e) => setSerial(e.target.value)} />
				</label>
				<label className={`rf-field${pointMissing ? ' rf-field-error' : ''}`}><span>Склад приёмки <span className="rf-required">обязательно</span></span>
					{stores.length ? (
						<select required aria-invalid={pointMissing} value={point} onChange={(e) => changePoint(e.target.value)}>
							<option value="">— обязательно выбери склад —</option>
							{stores.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
						</select>
					) : (
						<input required aria-invalid={pointMissing} type="text" value={point} placeholder="укажи склад приёмки" onChange={(e) => changePoint(e.target.value)} />
					)}
					{pointMissing && <span className="rf-field-error-text">Выбери склад приёмки</span>}
				</label>

				<label className="rf-field rf-wide">Внешний вид и комплектация
					<textarea value={appearance} rows={2} placeholder="царапины, сколы, что в комплекте…" onChange={(e) => setAppearance(e.target.value)} />
				</label>
				<label className="rf-field rf-wide">Описание неисправности
					<textarea value={defect} rows={2} placeholder="со слов клиента" onChange={(e) => setDefect(e.target.value)} />
				</label>
				<label className="rf-field rf-wide">Внутренний комментарий
					<textarea value={internalComment} rows={2} placeholder="для себя: что уточнить, кому позвонить, особенности ремонта…" onChange={(e) => setInternalComment(e.target.value)} />
					<span className="muted small">виден в карточке и общем списке, в печатный акт не попадает</span>
				</label>
				<label className="rf-field rf-wide">Комментарий сервисного центра
					<textarea value={comment} rows={2} disabled={!canEditPrice} placeholder={canEditPrice ? 'диагностика / итог ремонта — заполняется после возврата' : 'заполняет отдел снабжения'} onChange={(e) => setComment(e.target.value)} />
					{!canEditPrice && <span className="muted small">заполняет и правит только снабжение</span>}
				</label>

				<div className="rf-field">Вид ремонта
					<div className="rf-radio">
						<label><input type="radio" name="pay" checked={payType === 'warranty'} onChange={() => setPayType('warranty')} /> Гарантийный</label>
						<label><input type="radio" name="pay" checked={payType === 'paid'} onChange={() => setPayType('paid')} /> Платный</label>
					</div>
				</div>
				{payType === 'paid' && (
					<div className="rf-field rf-wide rf-prices">
						{canEditPrice ? (
							<label className="rf-price-col">Цена ремонта СЦ, ₽
								<input type="number" min="0" step="1" value={cost} placeholder="что берёт сервис-центр" onChange={(e) => setCost(e.target.value)} />
							</label>
						) : (
							<div className="rf-price-col">Цена ремонта СЦ
								<span className="rf-readonly">{cost.trim() !== '' ? `${cost} ₽` : 'укажет руководитель / отдел закупки'}</span>
							</div>
						)}
						{canEditPrice ? (
							<label className="rf-price-col">Наша цена, ₽
								<input type="number" min="0" step="1" value={ourPrice} placeholder="что берём с клиента → сделка" onChange={(e) => setOurPrice(e.target.value)} />
							</label>
						) : (
							<div className="rf-price-col">Наша цена
								<span className="rf-readonly">{ourPrice.trim() !== '' ? `${ourPrice} ₽` : 'укажет руководитель / отдел закупки'}</span>
							</div>
						)}
					</div>
				)}

				<label className="rf-field rf-wide">Файлы — фото и документы (Word, Excel, PDF)
					<input type="file" accept="image/*,.doc,.docx,.xls,.xlsx,.pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf" multiple onChange={(e) => void onAttach(e.target.files)} />
					{uploading && <span className="muted small">загружаю…</span>}
				</label>
			</div>

			{files.length > 0 && (
				<div className="rf-files">
					{files.map((f, i) => (
						<div key={`${f.id}-${i}`} className="rf-file">
							<span className="rf-file-ic">📄</span>
							<span className="rf-file-name">{f.name}</span>
							<button type="button" className="rf-file-x" title="Убрать" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>✕</button>
						</div>
					))}
				</div>
			)}

			{photos.length > 0 && (
				<div className="rf-photos">
					{photos.map((p, i) => (
						<div key={`${p.id}-${i}`} className="rf-photo">
							<img src={p.url} alt={p.name} />
							<button type="button" className="rf-photo-x" title="Убрать" onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}>✕</button>
						</div>
					))}
				</div>
			)}

			{formErr && <p className="error">⛔ {formErr}</p>}

			<div className="rf-actions">
				<button className="btn-primary" onClick={() => void onSubmit()} disabled={saving || uploading}>{saving ? (isEdit ? 'Сохраняю…' : 'Создаю…') : (isEdit ? 'Сохранить' : 'Создать')}</button>
				<button className="btn-secondary" onClick={onCancel} disabled={saving}>Отмена</button>
			</div>
		</div>
	);
}
