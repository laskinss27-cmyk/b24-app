# Security policy

## Repository data policy

This repository must not contain production secrets or infrastructure identifiers.

Do not commit:

- access tokens, incoming webhook URLs, OAuth secrets, passwords, or private keys;
- real production IP addresses, hostnames, portal domains, usernames, or customer identifiers;
- exact production filesystem paths, backup schedules, or recovery credentials;
- working `.env` files, database dumps, certificates, or private operational exports.

Documentation and configuration examples use reserved example domains and sanitised paths. Production values are supplied through private environment configuration.

## Before committing

1. Review the complete staged diff.
2. Search for tokens, credentials, production hosts, and customer data.
3. Use environment variables for every credential and deployment-specific address.
4. If a secret was committed, treat it as compromised and rotate it. Removing it from the latest revision is not enough.
5. History rewriting is a separate, coordinated operation. It must not be performed while other contributors continue pushing to the old history.

## Reporting a security issue

Do not open a public GitHub issue containing vulnerability details, credentials, production addresses, or customer data. Contact the repository owner through an existing private channel.

---

# Политика безопасности

В репозиторий нельзя добавлять рабочие секреты и идентификаторы инфраструктуры: токены, webhook URL, OAuth secret, пароли, приватные ключи, реальные IP и домены, точные серверные пути, расписания резервного копирования, `.env`, дампы БД и закрытые выгрузки.

Примеры конфигурации должны использовать только обезличенные значения. Если секрет уже попал в коммит, его считают скомпрометированным и заменяют; одной правки текущей версии недостаточно. Переписывание истории выполняется только как отдельная согласованная операция.
