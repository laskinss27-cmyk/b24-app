# SOS: аварийная диагностика

Начинайте с определения слоя, а не с перезапуска всего сервера.

## 1. Общая проверка

На VPS:

```bash
status
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:8080/api/method/ping
curl --fail https://201.51.12.57.sslip.io/health
```

Если команда `status` отсутствует, установить актуальную копию:

```bash
cp /root/b24-app-git/scripts/sos-status.sh /usr/local/bin/status
chmod +x /usr/local/bin/status
```

## 2. Не открываются все наши окна

Если внутренний health-check backend не отвечает:

```bash
docker ps -a --filter name=b24-backend
docker logs --tail 150 b24-backend
docker restart b24-backend
```

После перезапуска повторить оба health-check. Если проблема началась сразу после деплоя — выполнить откат по [runbook.md](runbook.md).

## 3. Внутренний health работает, публичный — нет

Проверить nginx и сертификат:

```bash
nginx -t
systemctl status nginx --no-pager
journalctl -u nginx --since "30 minutes ago" --no-pager
certbot certificates
systemctl status certbot.timer --no-pager
```

Перезагружать nginx можно только после успешного `nginx -t`.

## 4. Окна открываются, но нет складских данных

```bash
curl --fail http://127.0.0.1:8080/api/method/ping
cd /root/erpnext
docker compose -p erpnext -f pwd.yml ps
docker logs --tail 150 erpnext-backend-1
docker logs --tail 100 erpnext-db-1
```

Если отдельный контейнер остановлен, безопасно поднять существующий стек:

```bash
docker compose -p erpnext -f pwd.yml up -d
```

Не выполнять `down -v`, `volume rm` или очистку volumes.

## 5. Проблема только у одного сотрудника или в одном placement

Проверить:

1. открывается ли `https://201.51.12.57.sslip.io/health`;
2. работает ли другой наш раздел у того же пользователя;
3. есть ли у пользователя права Битрикс24 на соответствующую CRM-сущность;
4. повторяется ли ошибка после полного обновления страницы;
5. открывал ли приложение администратор после изменения placement.

Если новый раздел ограничен beta-гейтом, отсутствие пункта у обычного пользователя может быть ожидаемым.

## 6. Ошибка конкретной записи

Не повторять много раз записывающее действие. Записать:

- ID сделки, документа или ремонта;
- точное время;
- пользователя;
- текст ошибки;
- какой шаг был выполнен до ошибки.

Затем посмотреть логи backend за этот интервал:

```bash
docker logs --since "20 minutes ago" b24-backend
```

Перед повтором проверить, не был ли документ уже создан в ERPNext или Битрикс24.

## 7. Бэкап не прошёл

```bash
tail -200 /root/sync/core-backup.log
ls -lhtr /root/core-backups | tail
docker exec erpnext-backend-1 bench --site frontend backup
```

Ручной успешный дамп не заменяет проверку отправки на Диск Битрикс24. Не удалять старые копии вручную до восстановления автоматического задания.

## 8. После перезагрузки VPS

```bash
systemctl is-active docker nginx
cd /root/erpnext
docker compose -p erpnext -f pwd.yml up -d
docker start b24-backend
status
```

Контейнеры имеют restart policy, но итог всё равно подтверждается health-check.

## 9. Когда остановиться

Не проводить восстановление БД, массовую миграцию, очистку дублей или удаление контейнерных volumes как «попытку починить». Для таких действий нужны подтверждённая причина, свежий бэкап и согласованное окно работ.
