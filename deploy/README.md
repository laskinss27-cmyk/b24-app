# Развёртывание

[English](README.en.md) · **Русский**

В этой папке находятся проверяемые примеры конфигурации рабочего VPS.

| Файл | Рабочее расположение | Назначение |
|---|---|---|
| `pwd.yml` | `/root/erpnext/pwd.yml` | стек ERPNext, MariaDB, Redis и workers |
| `nginx-b24.conf` | `/etc/nginx/sites-available/b24` | HTTPS-вход и проксирование на backend |
| `backend.env.example` | образец для `/root/erpnext/backend.env` | переменные приложения |
| `sync.env.example` | образец для `/root/sync/.env` | доступ служебных скриптов к ERPNext и Битрикс24 |

Backend собирается из корневого [Dockerfile](../Dockerfile) и подключается к Docker-сети `erpnext_frappe_network`. Рабочий контейнер слушает порт `8080` внутри контейнера и опубликован только на `127.0.0.1:3000`.

Полная процедура:

- первичная установка и подключение к Битрикс24 — [docs/runbook.md](../docs/runbook.md);
- схема сети — [docs/network.md](../docs/network.md);
- действия при аварии — [docs/SOS.md](../docs/SOS.md).

Реальные `.env`, ключи, токены, дампы базы и сертификаты в Git не добавляются.
