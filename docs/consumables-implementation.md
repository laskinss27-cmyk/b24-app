# Расходные материалы: подготовленная доработка

Изменения выполнены в отдельной рабочей копии `D:/Projects/b24-app/outputs/consumables/release-worktree` на базе production commit `416376d`, чтобы не затронуть другие изменения основного checkout.

Подробности, тесты и порядок безопасного включения: [consumables.md](../outputs/consumables/release-worktree/docs/consumables.md).

Аудит: `outputs/consumables/read-only-candidates.json`. Проверка карточки/вариации и preview скрытия дубля: `outputs/consumables/retirement-preview.json`.

**Выложено после подтверждения пользователя 2026-09-07, около 19:40 МСК.** Commit `04b9e37`; image `b24-app:04b9e37-consumables-20260907163857248`.

Основная карточка 18612; 18610 — её родитель; 9254 — историческая услуга-дубль, теперь скрыта в Б24 (`active=N`) и новом выборе приложения. ERP Item не отключён. Цена закупки рассчитывается по строке сделки, а не записывается в общую закупочную цену или складскую оценку.

Internal/public health, официальный ERP read и сеть `erpnext_frappe_network` проверены. 14 целевых тестов прошли в развёрнутом образе, контрольные данные ERP до/после совпали, SQL-каталог содержит одну продаваемую карточку расходников. Rollback: `b24-backend-prev-before-04b9e37-consumables-20260907163857248`.
