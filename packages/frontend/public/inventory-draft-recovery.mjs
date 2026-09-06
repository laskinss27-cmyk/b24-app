// Standalone recovery reader: deliberately no application imports, auth or storage writes.
const PREFIX = 'b24-app:inventory-draft:v1:21648:-1865999992:';

export function readRecoverySnapshot(storage, origin, exportedAt = new Date().toISOString()) {
  const entries = [];
  const errors = [];
  for (const mode of ['count', 'act']) {
    const key = PREFIX + mode;
    let raw;
    try { raw = storage.getItem(key); }
    catch { errors.push({ key, error: 'storage_unavailable' }); continue; }
    if (raw === null) continue;
    // Retain the exact stored bytes, including pending:false and damaged JSON.
    const entry = { key, mode, raw, parsed: false, filled: null, updatedAt: null };
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        entry.parsed = true;
        entry.updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : null;
        if (value.draft && typeof value.draft === 'object' && !Array.isArray(value.draft)) {
          entry.filled = Object.entries(value.draft).filter(([id, qty]) =>
            /^\d+$/.test(id) && Number(id) > 0 && typeof qty === 'number' && Number.isFinite(qty) && qty >= 0
          ).length;
        }
      }
    } catch { /* Export damaged data unchanged; do not attempt a repair here. */ }
    entries.push(entry);
  }
  return { format: 'b24-inventory-local-recovery', version: 1, inventoryId: '21648',
    storeId: -1865999992, origin, exportedAt, entries, errors };
}

export function mountRecoveryPage(win, doc) {
  const el = (id) => doc.getElementById(id);
  let storage;
  try { storage = win.localStorage; } catch { /* Safari may deny storage access. */ }
  const snapshot = readRecoverySnapshot(storage, win.location.origin);
  const count = snapshot.entries.length;
  el('status').textContent = count
    ? `Найдена локальная копия${count > 1 ? ' в двух режимах' : ''}. Сохраните файл до дальнейших действий.`
    : snapshot.errors.length
      ? 'Safari не разрешил прочитать локальное хранилище. Не очищайте данные; пришлите скрин этой страницы.'
      : 'Локальная копия этой ревизии в этом Safari не найдена.';
  for (const entry of snapshot.entries) {
    const p = doc.createElement('p');
    const date = entry.updatedAt ? new Date(entry.updatedAt) : null;
    const when = date && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : 'дата неизвестна';
    p.textContent = `${entry.mode === 'count' ? 'Подсчёт' : 'Акт разногласий'}: ${entry.filled === null ? 'содержимое требует проверки' : `${entry.filled} заполненных позиций`}. ${when}.`;
    el('records').append(p);
  }
  if (!count) return snapshot;
  if (snapshot.errors.length) {
    const warning = doc.createElement('p');
    warning.textContent = 'Часть локального хранилища прочитать не удалось. Выгружены только доступные данные.';
    el('records').append(warning);
  }
  // Freeze the first read in memory: sharing/downloading never rereads or edits the draft.
  const text = JSON.stringify(snapshot, null, 2);
  const filename = 'bogatyrsky-21648-draft-' + snapshot.exportedAt.replace(/[:.]/g, '-') + '.json';
  el('raw').value = text;
  el('export').hidden = false;
  el('select').addEventListener('click', () => {
    el('raw').focus(); el('raw').select(); el('raw').setSelectionRange(0, text.length);
  });
  let file;
  try {
    file = new win.File([text], filename, { type: 'application/json' });
    const url = win.URL.createObjectURL(file);
    el('download').href = url;
    el('download').download = filename;
    el('download').hidden = false;
    // Keep the Blob URL alive for Safari's save/share sheet until this page is closed.
    el('download').addEventListener('click', () => {
      el('action-status').textContent = 'Если Safari откроет файл, выберите «Поделиться» → «Сохранить в Файлы». Затем отправьте сохранённый файл ответственному.';
    });
  } catch {
    el('action-status').textContent = 'Создать файл не удалось. Ниже можно скопировать текст целиком.';
  }
  try {
    if (file && typeof win.navigator.share === 'function' && win.navigator.canShare?.({ files: [file] })) {
      el('share').hidden = false;
      el('share').addEventListener('click', async () => {
        try {
          await win.navigator.share({ files: [file], title: 'Черновик ревизии Богатырского' });
          el('action-status').textContent = 'Меню отправки закрыто. Проверьте, что файл сохранён или дошёл получателю.';
        } catch (error) {
          el('action-status').textContent = error?.name === 'AbortError'
            ? 'Отправка отменена. Локальная копия не изменена.'
            : 'Отправить файл не удалось. Нажмите «Скачать файл» или скопируйте текст ниже.';
        }
      });
    }
  } catch { /* File download and manual text export remain available. */ }
  return snapshot;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') mountRecoveryPage(window, document);
