import { eq } from "drizzle-orm";
import { decryptApiKey, encryptApiKey, isValidEncryptedKey } from "@/lib/utils/encryption";
import type { ProviderOverride, StoredSecret } from "./types";

/**
 * 在线配置的持久化存储。
 *
 * 设计要点：
 * - **一个用户一行**：`ai_settings.id` 就是 user.id，别人的提供商、模型、Key 读不到也改不了。
 * - 只做"读一行 / 写一行"，不参与配置合并，避免和 config.ts 形成循环依赖。
 * - 数据库通过动态 import 懒加载：单元测试或未配置 DATABASE_URL 时不会因为
 *   导入 lib/db 而创建连接池，配置层仍能退回到 config/ai-providers.json。
 * - 任何读失败都降级为空设置（等同"没有在线配置"），不让页面/接口整体 500。
 */

export interface AiSettingsSnapshot {
  /** 当前生效的提供商 id；null 表示回退到环境变量/文件默认值 */
  activeProviderId: string | null;
  overrides: ProviderOverride[];
  secrets: Record<string, StoredSecret>;
}

export const EMPTY_AI_SETTINGS: AiSettingsSnapshot = {
  activeProviderId: null,
  overrides: [],
  secrets: {},
};

export type ProviderScope = string | null;
export type UserRole = "user" | "admin";

type DbModule = typeof import("@/lib/db");

let dbModule: DbModule | null = null;
let dbDisabled = false;
let warnedDbFailure = false;
/** 数据库读失败后的冷却截止时间，避免每个请求都去撞一个挂掉的连接 */
let dbCooldownUntil = 0;
const DB_FAILURE_COOLDOWN_MS = 30_000;

function warnOnce(message: string): void {
  if (warnedDbFailure) return;
  warnedDbFailure = true;
  console.warn(`[providers/store] ${message}`);
}

async function loadDb(): Promise<DbModule | null> {
  if (dbDisabled) return null;
  if (dbModule) return dbModule;

  try {
    dbModule = await import("@/lib/db");
    return dbModule;
  } catch (error) {
    dbDisabled = true;
    warnOnce(
      `数据库不可用，在线配置已停用（仅使用文件与环境变量）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** scope 为空（未登录 / 系统基线）时没有数据库行 */
export function normalizeScope(scope: ProviderScope): string | null {
  const trimmed = typeof scope === "string" ? scope.trim() : "";
  return trimmed || null;
}


function isOverride(value: unknown): value is ProviderOverride {
  return Boolean(value) && typeof value === "object" && typeof (value as ProviderOverride).id === "string";
}

function isStoredSecret(value: unknown): value is StoredSecret {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as StoredSecret).cipher === "string" &&
    (value as StoredSecret).cipher.length > 0
  );
}

function normalizeOverrides(value: unknown): ProviderOverride[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isOverride).map((item) => ({ ...item, id: item.id.trim() }));
}

function normalizeSecrets(value: unknown): Record<string, StoredSecret> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, StoredSecret] => isStoredSecret(entry[1]))
    .map(([id, secret]) => [id, { ...secret, hint: secret.hint ?? "…" }] as const);
  return Object.fromEntries(entries);
}

/** 读取某个用户的在线配置；不可用或没有用户时返回空设置 */
export async function readAiSettings(scope: ProviderScope): Promise<AiSettingsSnapshot> {
  const userId = normalizeScope(scope);
  if (!userId) return EMPTY_AI_SETTINGS;
  if (Date.now() < dbCooldownUntil) return EMPTY_AI_SETTINGS;

  const mod = await loadDb();
  if (!mod) return EMPTY_AI_SETTINGS;

  try {
    const rows = await mod.db
      .select({
        activeProviderId: mod.aiSettings.activeProviderId,
        overrides: mod.aiSettings.overrides,
        secrets: mod.aiSettings.secrets,
      })
      .from(mod.aiSettings)
      .where(eq(mod.aiSettings.id, userId))
      .limit(1);

    const row = rows[0];
    if (!row) return EMPTY_AI_SETTINGS;

    return {
      activeProviderId: typeof row.activeProviderId === "string" && row.activeProviderId.trim()
        ? row.activeProviderId.trim()
        : null,
      overrides: normalizeOverrides(row.overrides),
      secrets: normalizeSecrets(row.secrets),
    };
  } catch (error) {
    dbCooldownUntil = Date.now() + DB_FAILURE_COOLDOWN_MS;
    warnOnce(
      `读取 ai_settings 失败，${DB_FAILURE_COOLDOWN_MS / 1000}s 内使用文件配置：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EMPTY_AI_SETTINGS;
  }
}

/** 读取用户角色；用于判断能否修改内置提供商的连接信息 / 引用环境变量 Key */
export async function readUserRole(scope: ProviderScope): Promise<UserRole> {
  const userId = normalizeScope(scope);
  if (!userId) return "admin";

  const mod = await loadDb();
  if (!mod) return "user";

  try {
    const row = await mod.db.query.user.findFirst({
      where: eq(mod.user.id, userId),
      columns: { role: true },
    });
    return row?.role === "admin" ? "admin" : "user";
  } catch (error) {
    warnOnce(`读取用户角色失败，按普通用户处理：${error instanceof Error ? error.message : String(error)}`);
    return "user";
  }
}

/**
 * 写入某个用户的在线配置（整行 upsert）。
 * 调用方负责先读后改，单用户并发很低，这里不做乐观锁。
 */
export async function writeAiSettings(
  scope: ProviderScope,
  next: AiSettingsSnapshot,
  updatedBy?: string | null,
): Promise<AiSettingsSnapshot> {
  const userId = normalizeScope(scope);
  if (!userId) throw new Error("缺少用户身份，无法保存在线配置");

  const mod = await loadDb();
  if (!mod) {
    throw new Error("数据库不可用，无法保存在线配置。请检查 DATABASE_URL 或改用环境变量配置。");
  }

  const payload = {
    activeProviderId: next.activeProviderId,
    overrides: next.overrides,
    secrets: next.secrets,
    updatedBy: updatedBy ?? userId,
    updatedAt: new Date(),
  };

  await mod.db
    .insert(mod.aiSettings)
    .values({ id: userId, ...payload })
    .onConflictDoUpdate({ target: mod.aiSettings.id, set: payload });

  return next;
}

// ============ 平台密钥加解密 ============

/** 取密钥尾号用于展示，绝不下发明文 */
export function maskSecret(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 4) return "…";
  return `…${trimmed.slice(-4)}`;
}

/** 加密平台密钥；BETTER_AUTH_SECRET 缺失或过短时抛错，由调用方转成 400 */
export function encryptSecret(plain: string): StoredSecret {
  const value = plain.trim();
  if (!value) throw new Error("API Key 不能为空");

  return {
    cipher: encryptApiKey(value),
    hint: maskSecret(value),
    updatedAt: new Date().toISOString(),
  };
}

/** 解密平台密钥；格式不对或密钥已轮换时返回 null，让调用方继续找下一个来源 */
export function decryptSecret(secret: StoredSecret): string | null {
  if (!isValidEncryptedKey(secret.cipher)) return null;
  try {
    const plain = decryptApiKey(secret.cipher).trim();
    return plain || null;
  } catch (error) {
    warnOnce(`解密平台密钥失败（BETTER_AUTH_SECRET 可能已更换）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 仅用于测试 */
export function resetStoreState(): void {
  dbModule = null;
  dbDisabled = false;
  warnedDbFailure = false;
  dbCooldownUntil = 0;
}
