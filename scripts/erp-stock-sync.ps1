# Авто-синк остатков Б24 -> ERPNext (домашний этап выноса склада, 2026-06-12).
# Гоняется планировщиком Windows раз в час (задача b24-erp-stock-sync):
#   erp-migrate-catalog --stock (досыпает И зануляет) + --check (сверка) -> stock-sync.log.
# Пока Б24 — источник правды, инвариант синка: ядро = зеркало остатков Б24.
# ⚠ Следствие: после «Провести» документа ядра инвентаризации проводи зеркала
#   в Б24 СРАЗУ — иначе ближайший синк честно вернёт ядро к книге Б24.

$repo = 'D:\Projects\b24-app'
$log = Join-Path $repo 'scripts\stock-sync.log'
function Stamp { (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }

# ERPNext жив? (докер после ребута не автостартует — тогда тихо пропускаем час)
$ping = & curl.exe -s --noproxy localhost --connect-timeout 5 http://localhost:8080/api/method/ping 2>$null
if ($ping -notmatch 'pong') { Add-Content $log "[$(Stamp)] SKIP: ERPNext не отвечает (докер спит?)"; exit 0 }

Add-Content $log "[$(Stamp)] синк начат"
Set-Location $repo
try {
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
