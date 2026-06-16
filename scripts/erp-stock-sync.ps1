# Авто-синк остатков Б24 -> ERPNext (домашний этап выноса склада, 2026-06-12).
# ЦЕЛЬ С 2026-06-16: ядро СПЕЙРА (192.168.0.69) — после переезда приложение читает его, не основное.
# Гоняется планировщиком Windows раз в час (задача b24-erp-stock-sync):
#   erp-migrate-catalog --items (заводит/переименовывает новые товары) +
#   --stock (досыпает И зануляет остатки) + --check (сверка) -> stock-sync.log.
# ⚠ --items обязателен ПЕРЕД --stock: без него новый товар из Б24 валит проводку
#   остатков (Stock Reconciliation HTTP 417 «не найден код продукта»). Поймало 2026-06-15.
# Пока Б24 — источник правды, инвариант синка: ядро = зеркало остатков Б24.
# ⚠ Следствие: после «Провести» документа ядра инвентаризации проводи зеркала
#   в Б24 СРАЗУ — иначе ближайший синк честно вернёт ядро к книге Б24.

$repo = 'D:\Projects\b24-app'
$log = Join-Path $repo 'scripts\stock-sync.log'
# вывод npx — UTF-8; без этого кириллица итогов («ИТОГ», «СОШЛОСЬ») приходит кашей и фильтр строк слепнет
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Stamp { (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }

# Цель синка — ЯДРО СПЕЙРА (192.168.0.69:8080), его читает приложение. Б24 читаем как раньше
# (прокси на этом ноуте); ПИШЕМ в ядро спейра по локалке (undici прокси не уважает -> идёт напрямую).
$env:ERPNEXT_URL = 'http://192.168.0.69:8080'
$env:ERPNEXT_TOKEN = 'token 75a1085fa14560a:10fd22965d81d29'

# Ядро спейра живо? (ноут спейра выключен/недоступен — тихо пропускаем час)
$ping = & curl.exe -s --noproxy 192.168.0.69 --connect-timeout 5 http://192.168.0.69:8080/api/method/ping 2>$null
if ($ping -notmatch 'pong') { Add-Content $log "[$(Stamp)] SKIP: ядро спейра (192.168.0.69) не отвечает"; exit 0 }

Add-Content $log "[$(Stamp)] синк начат"
Set-Location $repo
try {
	$items = & npx tsx scripts/erp-migrate-catalog.ts --items 2>&1 | Out-String
	$itm = ($items -split "`n" | Where-Object { $_ -match 'ИТОГ товаров|FATAL' }) -join ' | '
	Add-Content $log "[$(Stamp)] items: $($itm.Trim())"
	$stock = & npx tsx scripts/erp-migrate-catalog.ts --stock 2>&1 | Out-String
	$loaded = ($stock -split "`n" | Where-Object { $_ -match 'строк к загрузке|зануление|Stock Reconciliation|FATAL' }) -join ' | '
	Add-Content $log "[$(Stamp)] stock: $($loaded.Trim())"
	$check = & npx tsx scripts/erp-migrate-catalog.ts --check 2>&1 | Out-String
	$itog = ($check -split "`n" | Where-Object { $_ -match 'ИТОГ|СОШЛОСЬ|расхождения|FATAL' }) -join ' | '
	Add-Content $log "[$(Stamp)] check: $($itog.Trim())"
} catch {
	Add-Content $log "[$(Stamp)] FATAL: $($_.Exception.Message)"
}

# лог не разъедается: держим хвост в 1000 строк
$lines = Get-Content $log -ErrorAction SilentlyContinue
if ($lines.Count -gt 1000) { $lines | Select-Object -Last 1000 | Set-Content $log -Encoding utf8 }
