const $ = (id) => document.getElementById(id);
let status = null, dialogs = [], opened = null, busy = false, epoch = 0, signature = '', messageSignature = '';
const labels = { setup:'Не подключён',connecting:'Подключаем…',qr:'Ожидаем QR-вход',ready:'Подключён',error:'Ошибка подключения',disconnecting:'Отключаем…' };
async function api(path,body) {
  const response = await fetch('/api/' + path,{ method:body === undefined ? 'GET':'POST',headers:{'X-Pilot-Request':'1',...(body === undefined ? {}:{'Content-Type':'application/json'})},...(body === undefined ? {}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Запрос не выполнен.'); return result;
}
function report(error) { $('error').textContent = error.message || 'Локальный сервер недоступен. Проверьте, что пилот запущен.'; $('error').hidden = false; }
function clearThread() { opened = null; messageSignature = ''; $('messages').replaceChildren(); $('thread-title').textContent = 'Переписка'; $('phone').textContent = 'Выберите диалог и нажмите «Открыть».'; $('freshness').textContent = ''; $('history').hidden = true; $('history-note').hidden = true; }
function renderState() {
  $('state').textContent = labels[status.state] || status.state;
  $('setup').hidden = status.state === 'ready'; $('workspace').hidden = !['ready','connecting','error'].includes(status.state) || !status.account;
  $('connect').hidden = !['setup','error'].includes(status.state); $('connect').disabled = busy;
  $('connect').textContent = status.state === 'error' ? 'Повторить подключение' : 'Показать QR-код';
  $('disconnect').hidden = status.state === 'setup'; $('disconnect').disabled = busy || status.state === 'disconnecting';
  $('connecting').hidden = status.state !== 'connecting'; $('qr-box').hidden = status.state !== 'qr' || !status.qr;
  if (status.qr && $('qr').getAttribute('src') !== status.qr) $('qr').src = status.qr;
  if (!status.qr) $('qr').removeAttribute('src');
  $('account').textContent = status.account?.name || '';
  if (status.error) report(Error(status.error)); renderHistory();
  if (status.state === 'setup') { dialogs = []; signature = ''; $('dialogs').replaceChildren(); clearThread(); }
}
function renderDialogs() {
  const query = $('search').value.trim().toLocaleLowerCase('ru');
  const filtered = dialogs.filter((d) => `${d.title} ${d.phone || ''}`.toLocaleLowerCase('ru').includes(query));
  const nextSignature = JSON.stringify(filtered);
  if (signature === nextSignature) return; signature = nextSignature;
  const focused = document.activeElement?.dataset?.chat;
  const focusedKind = document.activeElement?.tagName;
  const items = filtered.map((dialog) => {
    const li = document.createElement('li'), label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span'), meta = document.createElement('span'), button = document.createElement('button');
    input.type = 'checkbox'; input.checked = dialog.selected; input.dataset.chat = dialog.id;
    text.textContent = dialog.title; meta.className = 'meta'; meta.textContent = `${dialog.phone || 'Номер не передан'} · ${dialog.count} сообщений`; text.append(meta); label.append(input,text);
    input.addEventListener('change', () => { const requested = input.checked; run(async () => { try { status = await api('select',{chatId:dialog.id,selected:requested}); } finally { if (opened === dialog.id && !requested) clearThread(); signature = ''; await loadDialogs(); } }); });
    button.type = 'button'; button.textContent = 'Открыть'; button.disabled = !dialog.selected; button.dataset.chat = dialog.id;
    button.addEventListener('click',() => run(async () => { opened = dialog.id; await loadMessages(); $('thread-title').focus(); if (!status.history?.requests?.some(r=>r.id===opened)) await requestHistory(); }));
    li.append(label,button); return li;
  });
  $('dialogs').replaceChildren(...items);
  $('empty').hidden = filtered.length > 0;
  $('empty').textContent = query ? 'Совпадений нет.' : status.historyReceived ? 'Личные диалоги пока не получены. Попробуйте обычную переписку с телефона.' : 'Ожидаем список от WhatsApp. Это может занять несколько минут.';
  if (focused) [...$('dialogs').querySelectorAll('[data-chat]')].find((el) => el.dataset.chat === focused && el.tagName === focusedKind)?.focus();
}
async function loadDialogs() {
  const currentEpoch = epoch; const result = await api('dialogs'); if (currentEpoch !== epoch) return;
  dialogs = result.dialogs; renderDialogs();
  if (opened && !dialogs.some((d) => d.id === opened && d.selected)) clearThread();
}
async function loadMessages() {
  if (!opened) return;
  const id = opened, currentEpoch = epoch;
  const result = await api('messages?chatId=' + encodeURIComponent(id)); if (epoch !== currentEpoch || id !== opened) return;
  $('history').hidden = false; renderHistory();
  const nextSignature = JSON.stringify(result); if (nextSignature === messageSignature) return; messageSignature = nextSignature;
  $('thread-title').textContent = result.title; $('phone').textContent = result.phone ? `Номер для поиска в CRM: ${result.phone}` : 'Номер пока не передан. Автопривязка по телефону недоступна.';
  $('freshness').textContent = 'Получено сообщений: ' + result.messages.length + '. Обновлено: ' + new Date().toLocaleTimeString('ru');
  const nodes = result.messages.map((m) => { const li = document.createElement('li'), meta = document.createElement('small'), text = document.createElement('span'); li.className = m.outgoing ? 'outgoing' : ''; meta.textContent = `${m.outgoing ? 'Вы → клиент' : 'Клиент → вы'} · ${new Date(m.date).toLocaleString('ru')}`; text.textContent = m.text + (m.attachment ? '\n[' + m.attachment + ']' : ''); li.append(meta,text); return li; });
  if (!nodes.length) { const li = document.createElement('li'); li.textContent = 'Сообщения ещё не получены. Новая переписка появится здесь автоматически.'; nodes.push(li); }
  $('messages').replaceChildren(...nodes);
}
async function run(action) {
  const deadline = Date.now() + 15000;
  while (busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,100));
  if (busy) { report(Error('Предыдущий запрос ещё выполняется. Попробуйте снова.')); return; }
  busy = true; $('error').hidden = true; $('notice').hidden = true;
  if (status) renderState();
  try { await action(); } catch(error) { report(error); } finally { busy = false; if (status) renderState(); }
}
function renderHistory() {
  const h=status?.history;
  $('sync-summary').hidden=!h||!status.account;
  if(h&&status.account) $('sync-summary').textContent=h.expandedChats>0 ? 'Получена история нескольких сообщений: '+h.expandedChats+' диалогов.' : h.initialTimeout ? 'За 90 секунд расширенная история не получена. Дальше ждать не нужно: требуется проверка синхронизации.' : 'Проверяем первоначальную загрузку истории. Это займёт не более 90 секунд.';
  const request=h?.requests?.find(r=>r.id===opened);
  if(!request)return;
  const texts={empty:'WhatsApp ответил на запрос, но не передал дополнительные сообщения. Это не означает, что на телефоне нет истории.',pending:'Запрос отправлен. Ожидаем ответ телефона не более 90 секунд.',timeout:'Телефон не передал предыдущие сообщения за 90 секунд. Дальше ждать не нужно.',failed:'Запрос истории завершился ошибкой. Новые сообщения можно проверять отдельно.',received:'Из истории получены дополнительные сообщения: '+request.added+'. Это не гарантия полного архива.'};
  $('history-note').textContent=texts[request.state]||''; $('history-note').hidden=false;
}
async function requestHistory() {
  if (!opened) return;
  const id = opened, currentEpoch = epoch;
  $('history').disabled = true;
  try { const result = await api('history',{chatId:id}); if (opened === id && epoch === currentEpoch) { $('history-note').textContent = result.note; $('history-note').hidden = false; } }
  finally { $('history').disabled = false; }
}
$('history').addEventListener('click',()=>run(requestHistory));
$('connect').addEventListener('click',()=>run(async()=>{ ++epoch; status = await api('connect',{}); }));
$('disconnect').addEventListener('click',()=>run(async()=>{ ++epoch; const result = await api('disconnect',{}); clearThread(); status = await api('status'); $('notice').textContent = result.warning || 'Сессия отключена. Данные пилота очищены.'; $('notice').hidden = false; $('connect').focus(); }));
$('search').addEventListener('input',()=>{ signature=''; renderDialogs(); });
async function refresh() {
  if (busy || document.hidden || (status?.state === 'ready' && !$('live').checked)) return;
  busy = true;
  try { status = await api('status'); renderState(); if (status.account) { await loadDialogs(); await loadMessages(); } if (!status.error) $('error').hidden = true; }
  catch { report(Error('Локальный сервер недоступен. Проверьте, что пилот запущен.')); }
  finally { busy = false; if (status) renderState(); }
}
$('live').addEventListener('change',()=>refresh());
refresh(); setInterval(refresh,2000);
