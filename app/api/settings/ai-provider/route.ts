import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db, operationLogs } from "@/lib/db";
import {
  describeProviders,
  getActiveProviderId,
  getDefaultProviderId,
  getProviderCatalog,
  refreshProviderCatalog,
} from "@/lib/ai/providers";
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
 * **配置跟着账号走**：每个用户只读写自己那一行（`ai_settings.id = user.id`），
 * 别人配的提供商、模型、Key 既不会出现在列表里，也无法被调用。
 *
 * 所有写操作都会落到数据库并立刻刷新该用户的快照，因此不需要重启进程。
 * 非管理员不能修改内置提供商的连接信息（协议 / baseUrl / 路径），
 * 否则可以把 baseUrl 指向自己的服务器，顺走平台环境变量里的 Key。
 */

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

function providerSnapshot(scope: string) {
  const catalog = getProviderCatalog(scope);
  return {
    activeProviderId: getActiveProviderId(scope),
    defaultProviderId: getDefaultProviderId(scope),
    // providers 只含启用的，供切换下拉使用
    providers: describeProviders(scope),
    // allProviders 含停用项，供设置页管理
    allProviders: describeProviders(scope, process.env, { includeDisabled: true }),
    /** 能否修改内置提供商的连接信息（仅管理员） */
    definitionsEditable: catalog.definitionsEditable,
    /** 历史字段，等价于 definitionsEditable */
    isAdmin: catalog.definitionsEditable,
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

// GET /api/settings/ai-provider - 列出「我的」提供商、当前选择、以及可编辑的原始覆盖项
export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 先对齐该用户的在线配置，避免新实例返回文件默认值
    await refreshProviderCatalog(session.user.id);

    return NextResponse.json({
      ...providerSnapshot(session.user.id),
      protocols: PROVIDER_PROTOCOLS,
    });
  } catch (error) {
    console.error("[ai-provider] 读取提供商列表失败：", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/settings/ai-provider - 切换提供商 / 切换模型 / 保存 Key / 测试连通性
export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const scope = session.user.id;

    const body = await request.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action : "activate";

    if (action === "test") {
      const parsed = switchSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

      const result = await testProvider(scope, parsed.data.providerId);
      return NextResponse.json({ ...providerSnapshot(scope), test: result });
    }

    if (action === "set-model") {
      const parsed = modelSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

      await saveProviderModel(scope, parsed.data.providerId, parsed.data.model, scope);
      await logChange(scope, parsed.data.providerId, "set-model", { model: parsed.data.model });
      return NextResponse.json({ success: true, ...providerSnapshot(scope) });
    }

    if (action === "set-key") {
      const parsed = keySchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

      if (parsed.data.clear) {
        await clearProviderKey(scope, parsed.data.providerId, scope);
        await logChange(scope, parsed.data.providerId, "clear-key");
      } else {
        if (!parsed.data.apiKey) return badRequest("缺少 apiKey");
        await saveProviderKey(scope, parsed.data.providerId, parsed.data.apiKey, scope);
        await logChange(scope, parsed.data.providerId, "set-key");
      }
      return NextResponse.json({ success: true, ...providerSnapshot(scope) });
    }

    if (action !== "activate") {
      return badRequest(`不支持的操作：${action}`);
    }

    const parsed = switchSchema.safeParse(body);
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "参数不合法");

    await refreshProviderCatalog(scope);
    const previousProviderId = getActiveProviderId(scope);
    await saveActiveProvider(scope, parsed.data.providerId, scope);
    await logChange(scope, parsed.data.providerId, "activate", { previousProviderId });

    return NextResponse.json({ success: true, ...providerSnapshot(scope) });
  } catch (error) {
    if (error instanceof ProviderConfigError) return badRequest(error.message);
    console.error("[ai-provider] 操作失败：", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/settings/ai-provider - 新增或修改「我的」提供商（baseUrl / 协议 / 模型 / Key）
export async function PUT(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const scope = session.user.id;

    const body = await request.json().catch(() => null);
    const parsed = providerUpsertSchema.safeParse(body);
    if (!parsed.success) {
      return badRequest(parsed.error.issues.map((issue) => issue.message).join("；"));
    }

    const result = await upsertProvider(scope, parsed.data, scope);
    await logChange(scope, parsed.data.id, result.created ? "create-provider" : "update-provider", {
      keyUpdated: result.keyUpdated,
      keyCleared: result.keyCleared,
    });

    return NextResponse.json({ success: true, ...result, ...providerSnapshot(scope) });
  } catch (error) {
    if (error instanceof ProviderConfigError) return badRequest(error.message);
    console.error("[ai-provider] 保存提供商失败：", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/settings/ai-provider?providerId=xxx - 删除「我的」在线新增提供商 / 恢复内置默认值
// 不带 providerId 时：清除我的切换记录，回到默认提供商
export async function DELETE(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const scope = session.user.id;

    const providerId = request.nextUrl.searchParams.get("providerId")?.trim();

    if (!providerId) {
      await refreshProviderCatalog(scope);
      const previousProviderId = getActiveProviderId(scope);
      await resetActiveProviderPersisted(scope, scope);
      await logChange(scope, getActiveProviderId(scope), "reset-active", { previousProviderId });
      return NextResponse.json({ success: true, ...providerSnapshot(scope) });
    }

    const result = await removeProviderOverride(scope, providerId, scope);
    await logChange(scope, providerId, result.mode === "deleted" ? "delete-provider" : "reset-provider");

    return NextResponse.json({ success: true, mode: result.mode, ...providerSnapshot(scope) });
  } catch (error) {
    if (error instanceof ProviderConfigError) return badRequest(error.message);
    console.error("[ai-provider] 重置提供商失败：", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
