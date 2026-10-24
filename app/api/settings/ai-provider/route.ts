import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db, operationLogs, user } from "@/lib/db";
import { describeProviders, getActiveProviderId, getDefaultProviderId, refreshProviderCatalog } from "@/lib/ai/providers";
import { PROVIDER_PROTOCOLS } from "@/lib/ai/providers/types";
import { ProviderConfigError } from "@/lib/ai/providers/errors";
import {
  clearProviderKey,
  providerUpsertSchema,
  removeProviderOverride,
  resetActiveProviderPersisted,
  saveActiveProvider,
  saveProviderKey,
  saveProviderModel,
  testProvider,
  upsertProvider,
} from "@/lib/ai/providers/admin";

/**
 * AI 提供商在线配置接口。
 *
 * 读：所有登录用户可见（脱敏）；写：仅管理员。
 * 所有写操作都会落到数据库并立刻刷新内存快照，因此不需要重启进程。
 */

async function isAdmin(userId: string): Promise<boolean> {
  const currentUser = await db.query.user.findFirst({ where: eq(user.id, userId) });
  return currentUser?.role === "admin";
}

async function logChange(
  userId: string,
  providerId: string | null,
  kind: string,
  extra: Record<string, unknown> = {},
) {
  try {
    await db.insert(operationLogs).values({
      userId,
      action: "settings.update",
      resourceType: "ai_provider",
      metadata: { kind, providerId, ...extra },
    });
  } catch (error) {
    console.warn("[ai-provider] 操作日志写入失败：", error);
  }
}

function providerSnapshot() {
  return {
    activeProviderId: getActiveProviderId(),
    defaultProviderId: getDefaultProviderId(),
    // providers 只含启用的，供切换下拉使用
    providers: describeProviders(),
    // allProviders 含停用项，供设置页管理
    allProviders: describeProviders(process.env, { includeDisabled: true }),
  };
}

const switchSchema = z.object({
  providerId: z.string().trim().min(1),
});

const modelSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1).max(200),
});

const keySchema = z.object({
  providerId: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).max(500).optional(),
  clear: z.boolean().optional(),
});

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

// GET /api/settings/ai-provider - 列出提供商、当前选择、以及可编辑的原始覆盖项
export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 先对齐在线配置，避免新实例返回文件默认值
    await refreshProviderCatalog();

    return NextResponse.json({
      ...providerSnapshot(),
      isAdmin: await isAdmin(session.user.id),
      protocols: PROVIDER_PROTOCOLS,
    });
  } catch (error) {
    console.error("[ai-provider] 读取提供商列表失败：", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/settings/ai-provider - 切换提供商 / 切换模型 / 测试连通性
export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await isAdmin(session.user.id))) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action : "activate";

    if (action === "test") {
      const parsed = switchSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

      const result = await testProvider(parsed.data.providerId, session.user.id);
      return NextResponse.json({ ...providerSnapshot(), test: result });
    }

    if (action === "set-model") {
      const parsed = modelSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

      await saveProviderModel(parsed.data.providerId, parsed.data.model, session.user.id);
      await logChange(session.user.id, parsed.data.providerId, "set-model", { model: parsed.data.model });
      return NextResponse.json({ success: true, ...providerSnapshot() });
    }

    if (action === "set-key") {
      const parsed = keySchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

      if (parsed.data.clear) {
        await clearProviderKey(parsed.data.providerId, session.user.id);
        await logChange(session.user.id, parsed.data.providerId, "clear-key");
      } else {
        if (!parsed.data.apiKey) return badRequest("缺少 apiKey");
        await saveProviderKey(parsed.data.providerId, parsed.data.apiKey, session.user.id);
        await logChange(session.user.id, parsed.data.providerId, "set-key");
      }
      return NextResponse.json({ success: true, ...providerSnapshot() });
    }

    if (action !== "activate") {
      return badRequest(`不支持的操作：${action}`);
    }

    const parsed = switchSchema.safeParse(body);
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

    await refreshProviderCatalog();
    const previousProviderId = getActiveProviderId();
    await saveActiveProvider(parsed.data.providerId, session.user.id);
    await logChange(session.user.id, parsed.data.providerId, "activate", { previousProviderId });

    return NextResponse.json({ success: true, ...providerSnapshot() });
  } catch (error) {
    if (error instanceof ProviderConfigError) return badRequest(error.message);
    console.error("[ai-provider] 操作失败：", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/settings/ai-provider - 新增或修改提供商（baseUrl / 协议 / 模型 / Key）
export async function PUT(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await isAdmin(session.user.id))) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const parsed = providerUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues.map((issue) => issue.message).join("；"));
    }

    const result = await upsertProvider(parsed.data, session.user.id);
    await logChange(session.user.id, parsed.data.id, result.created ? "create-provider" : "update-provider", {
      keyUpdated: result.keyUpdated,
      keyCleared: result.keyCleared,
    });

    return NextResponse.json({ success: true, ...result, ...providerSnapshot() });
  } catch (error) {
    if (error instanceof ProviderConfigError) return badRequest(error.message);
    console.error("[ai-provider] 保存提供商失败：", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/settings/ai-provider?providerId=xxx - 删除在线新增 / 恢复内置默认值
// 不带 providerId 时：清除在线切换记录，回到默认提供商
export async function DELETE(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await isAdmin(session.user.id))) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const providerId = request.nextUrl.searchParams.get("providerId")?.trim();

    if (!providerId) {
      await refreshProviderCatalog();
      const previousProviderId = getActiveProviderId();
      await resetActiveProviderPersisted(session.user.id);
      await logChange(session.user.id, getActiveProviderId(), "reset-active", { previousProviderId });
      return NextResponse.json({ success: true, ...providerSnapshot() });
    }

    const result = await removeProviderOverride(providerId, session.user.id);
    await logChange(session.user.id, providerId, result.mode === "deleted" ? "delete-provider" : "reset-provider");

    return NextResponse.json({ success: true, mode: result.mode, ...providerSnapshot() });
  } catch (error) {
    if (error instanceof ProviderConfigError) return badRequest(error.message);
    console.error("[ai-provider] 重置提供商失败：", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
