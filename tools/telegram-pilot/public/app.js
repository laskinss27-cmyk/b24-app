const $ = (id) => document.getElementById(id);
let state = { state:'setup', selected:[] }, dialogs = [], activeId = null, busy = false, refreshBusy = false;
const showError = (message = '') => { $('error').textContent = message; $('error').hidden = !message; };
async function api(path, body) {
  const options = { headers:{ 'X-Pilot-Request':'1' }, cache:'no-store' };
  if (body !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await fetch(`/api/${path}`, options);
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
async function action(run) {
  if (busy) return; busy = true; showError(); document.querySelectorAll('button').forEach((b) => b.disabled = true);
  try { await run(); } catch (error) { showError(error.message); }
  finally { busy = false; document.querySelectorAll('button').forEach((b) => b.disabled = false); }
}
function renderState(next) {
  const previous = state.state; state = next;
  $('test-mode').hidden = !state.testOnly;
  $('setup').hidden = !['setup','error'].includes(state.state);
  $('login').hidden = ['setup','error','ready'].includes(state.state);
  $('workspace').hidden = state.state !== 'ready'; $('disconnect').hidden = state.state === 'setup';
  $('qr-box').hidden = state.state !== 'qr'; $('password-form').hidden = state.state !== 'password';
  if (state.qr && $('qr').src !== state.qr) $('qr').src = state.qr;
  if (!state.qr) $('qr').removeAttribute('src');
  $('status').textContent = ({ setup:'', connecting:'Соединяемся с Telegram…', qr:'QR-код готов. Подтвердите вход на телефоне.', password:'Telegram запросил пароль двухэтапной проверки.', ready:'Аккаунт подключён. Выберите клиентские диалоги.', error:'Вход не завершён.' })[state.state];
  if (state.error) showError(state.error);
  if (state.account) $('account').textContent = state.account.name;
  if (previous !== state.state) {
    if (state.state === 'password') $('password-form').elements.password.focus();
    if (state.state === 'ready') $('load-dialogs').focus();
    if (['setup','error'].includes(state.state)) $('test-connect').focus();
  }
}
function clearThread() { activeId = null; $('messages').replaceChildren(); $('thread-content').hidden = true; $('thread-empty').hidden = false; $('binding-form').reset(); delete $('binding-form').dataset.chatId; }
function renderDialogs() {
  $('dialogs').replaceChildren();
  const selected = new Set(state.selected.map((d) => d.id));
  const filtered = dialogs.filter((d) => d.title.toLocaleLowerCase().includes($('search').value.toLocaleLowerCase()));
  $('dialog-status').textContent = dialogs.length ? `Выбрано ${selected.size} из 2 · найдено ${filtered.length}` : state.dialogsLoaded ? 'Личных клиентских диалогов в списке нет.' : 'Сначала загрузите список диалогов.';
  if (dialogs.length && !filtered.length) $('dialog-status').textContent += ' · Попробуйте другое имя.';
  for (const dialog of filtered) {
    const li = document.createElement('li'); li.className = 'dialog-row';
    const label = document.createElement('label'), checkbox = document.createElement('input'), title = document.createElement('span');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(dialog.id); title.textContent = dialog.title;
    label.append(checkbox,title); li.append(label);
    checkbox.addEventListener('change', () => { const shouldSelect = checkbox.checked; action(async () => {
      try { renderState(await api('select', { chatId:dialog.id, selected:shouldSelect })); }
      finally { renderDialogs(); }
      if (!shouldSelect && activeId === dialog.id) clearThread();
    }); });
    if (checkbox.checked) { const button = document.createElement('button'); button.textContent = 'Открыть сообщения'; button.addEventListener('click', () => action(async () => { clearThread(); activeId = dialog.id; await refresh(); })); li.append(button); }
    $('dialogs').append(li);
  }
}
async function refresh() {
  if (!activeId || refreshBusy || state.state !== 'ready') return;
  refreshBusy = true; const id = activeId;
  try {
    const thread = await api(`messages?chatId=${encodeURIComponent(id)}`);
    if (activeId !== id || !state.selected.some((d) => d.id === id)) return;
    $('thread-empty').hidden = true; $('thread-content').hidden = false; $('thread-title').textContent = thread.title;
    $('freshness').textContent = `Последние 100 сообщений · обновлено ${new Date(thread.refreshedAt).toLocaleTimeString('ru-RU')} · обновляем каждые 15 секунд`;
    const form = $('binding-form');
    if (form.dataset.chatId !== id) { form.reset(); form.dataset.chatId = id; if (thread.binding) { form.elements.kind.value = thread.binding.kind; form.elements.id.value = thread.binding.id; } }
    $('binding-status').textContent = thread.binding ? `Пробная привязка: ${thread.binding.kind === 'deal' ? 'сделка' : 'лид'} № ${thread.binding.id}. Карточка не проверена и не изменена.` : 'Привязки пока нет. Номер можно взять из адреса карточки в Битрикс24.';
    $('messages').replaceChildren();
    for (const message of thread.messages) {
      const li = document.createElement('li'); li.className = `message${message.outgoing ? ' outgoing' : ''}`;
      const meta = document.createElement('div'); meta.className = 'meta'; const sender = document.createElement('strong'); sender.textContent = message.outgoing ? 'Вы' : 'Клиент';
      const time = document.createElement('time'); time.dateTime = message.date; time.textContent = new Date(message.date).toLocaleString('ru-RU'); meta.append(sender,time); li.append(meta);
      if (message.text) { const p = document.createElement('p'); p.textContent = message.text; li.append(p); }
      if (message.attachment) { const p = document.createElement('p'); p.className = 'attachment'; p.textContent = `${message.attachment} · просмотр вложений добавим после пробы`; li.append(p); }
      $('messages').append(li);
    }
    if (!thread.messages.length) { const li = document.createElement('li'); li.textContent = 'В этом диалоге пока нет сообщений.'; $('messages').append(li); }
  } finally { refreshBusy = false; }
}
$('test-connect').addEventListener('click', () => action(async () => renderState(await api('connect-test', {}))));
$('credentials').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget; const body = { apiId:form.elements.apiId.value, apiHash:form.elements.apiHash.value };
  action(async () => { renderState(await api('connect',body)); form.elements.apiHash.value = ''; });
});
$('password-form').addEventListener('submit', (event) => { event.preventDefault(); const input = event.currentTarget.elements.password, password = input.value; input.value = ''; action(async () => renderState(await api('password',{ password }))); });
$('load-dialogs').addEventListener('click', () => action(async () => { dialogs = (await api('dialogs',{})).dialogs; renderState(await api('status')); renderDialogs(); }));
$('search').addEventListener('input',renderDialogs);
$('refresh').addEventListener('click', () => action(refresh));
$('binding-form').addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget, body = { chatId:activeId, kind:form.elements.kind.value, id:form.elements.id.value }; action(async () => { renderState(await api('bind',body)); await refresh(); }); });
$('disconnect').addEventListener('click', () => action(async () => { const result = await api('disconnect',{}); dialogs = []; clearThread(); $('password-form').reset(); $('credentials').reset(); renderState(await api('status')); renderDialogs(); if (result.warning) showError(result.warning); }));
let polling = false;
async function poll() { if (polling || busy) return; polling = true; try { const next = await api('status'); if (next.state === 'setup' && state.state !== 'setup') { dialogs = []; clearThread(); renderDialogs(); } renderState(next); } catch { showError('Пробный сервер недоступен. Дождитесь запуска и обновите страницу.'); } finally { polling = false; } }
poll(); setInterval(poll,2000);
setInterval(() => { if (!busy && !document.hidden) refresh().catch((error) => showError(error.message)); },15000);
