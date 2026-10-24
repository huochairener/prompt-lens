CREATE TABLE IF NOT EXISTS "ai_settings" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"active_provider_id" varchar(64),
	"overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 放开提供商枚举：在线新增的提供商也需要能保存用户自备 Key
ALTER TABLE "user_api_keys" ALTER COLUMN "provider" SET DATA TYPE varchar(64) USING "provider"::text;--> statement-breakpoint
ALTER TABLE "ai_settings" DROP CONSTRAINT IF EXISTS "ai_settings_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."api_provider";
