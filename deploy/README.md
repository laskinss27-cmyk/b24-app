# deploy/ — инфраструктура развёртывания (корп-VPS)

Файлы, нужные, чтобы поднять систему с нуля. Полная процедура — в [../docs/runbook.md](../docs/runbook.md).

| Файл | Куда на VPS | Что это |
|---|---|---|
| `pwd.yml` | `/root/erpnext/pwd.yml` | docker compose ядра ERPNext (проект `erpnext`, сеть `erpnext_frappe_network`) |
| `nginx-b24.conf` | `/etc/nginx/sites-available/b24` | публичная дверь nginx :443 → backend `127.0.0.1:3000` |
| `backend.env.example` | → `/root/erpnext/backend.env` | env приложения (заполнить значениями, НЕ коммитить реальные) |
| `sync.env.example` | → `/root/sync/.env` | env синка/бэкапа (заполнить значениями) |

Скрипты синка/бэкапа/статуса — в [../scripts/](../scripts/): `sync.sh`, `core-backup.sh`, `core-backup-disk.ts`, `sos-status.sh`.

Backend собирается из корневого `Dockerfile`. Данные ядра восстанавливаются из бэкапа (см. runbook раздел B).
