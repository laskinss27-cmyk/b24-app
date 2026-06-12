# Мост ядра: обратный ssh-туннель ноутбук -> VPS 194.226.97.154 (домашний этап выноса склада).
# VPS:18080 -> localhost:8080 (ERPNext в докере). Прод-бэкенд b24-app ходит на http://194.226.97.154:18080.
# Вечный цикл: ssh умер (сеть/сон ноутбука) -> ждём 15с -> поднимаем заново.
# Автозагрузка: задача планировщика b24-erp-bridge (ONLOGON). Лог: scripts\bridge.log (хвост 500 строк).
# Ключ: ~\.ssh\b24_bridge (ed25519, только на этом ноутбуке; парольный вход на VPS отключён).

$log = 'D:\Projects\b24-app\scripts\bridge.log'
$key = "$env:USERPROFILE\.ssh\b24_bridge"
function Stamp { (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }

# не плодим вторую копию моста (задача + ручной запуск)
$mine = $PID
$dup = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match '18080:localhost:8080' }
if ($dup) { Add-Content $log "[$(Stamp)] уже работает (pid $($dup.ProcessId)) — выходим"; exit 0 }

Add-Content $log "[$(Stamp)] мост стартует (pid $mine)"
while ($true) {
	& ssh -i $key -N `
		-o StrictHostKeyChecking=accept-new `
		-o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
		-o ExitOnForwardFailure=yes -o ConnectTimeout=15 `
		-R '0.0.0.0:18080:localhost:8080' root@194.226.97.154 2>&1 |
		ForEach-Object { Add-Content $log "[$(Stamp)] ssh: $_" }
	Add-Content $log "[$(Stamp)] туннель упал — перезапуск через 15с"
	Start-Sleep -Seconds 15
	# лог не разъедается
	$lines = Get-Content $log -ErrorAction SilentlyContinue
	if ($lines.Count -gt 500) { $lines | Select-Object -Last 500 | Set-Content $log -Encoding utf8 }
}
