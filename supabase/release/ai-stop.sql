-- ОСТАНОВКА AI (после миграции №10.2): новые запуски получают AI_PAUSED, идущие завершаются (до ~140 с).
update private.ai_limits set ai_enabled = false, updated_at = now() where id;
-- Включить: update private.ai_limits set ai_enabled = true, updated_at = now() where id;
-- Проверка: select ai_enabled, total_starts, max_total_starts from private.ai_limits;
