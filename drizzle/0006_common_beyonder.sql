ALTER TABLE "ai_settings" ALTER COLUMN "id" SET DATA TYPE varchar(64);--> statement-breakpoint
-- ai_settings 从「全局一行」升级为「一个用户一行」：
-- 主键改为 user.id，提供商、模型、Key 都跟着账号走，互相不可见。
-- 旧的 'global' 行归属给最后修改它的账号（没有则第一个管理员），避免升级后配置消失。
-- 找不到任何归属时保留 'global' 行不做处理——它不会再被任何用户读到，但数据仍在。
WITH "owner" AS (
	SELECT COALESCE(
		(SELECT "updated_by"::text FROM "ai_settings" WHERE "id" = 'global'),
		(SELECT "id"::text FROM "user" WHERE "role" = 'admin' ORDER BY "created_at" LIMIT 1)
	) AS "id"
)
UPDATE "ai_settings"
SET "id" = (SELECT "id" FROM "owner"),
	"updated_by" = (SELECT "id"::uuid FROM "owner"),
	"updated_at" = now()
WHERE "id" = 'global'
	AND (SELECT "id" FROM "owner") IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM "ai_settings" AS "existing"
		WHERE "existing"."id" = (SELECT "id" FROM "owner")
	);
