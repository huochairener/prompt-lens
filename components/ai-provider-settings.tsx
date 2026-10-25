"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages";

interface ProviderStatus {
  id: string;
  label: string;
  protocol: Protocol;
  baseUrl: string;
  path: string;
  defaultModel?: string;
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  keyStrategy: "platform" | "user" | "either";
  hasOwnKey: boolean;
  keyHint?: string;
  hasPlatformKey: boolean;
  keySource: "own" | "platform" | "none";
  custom: boolean;
  overriddenFields: string[];
  active: boolean;
  enabled: boolean;
  effectiveModel?: string;
  /** 能否修改连接信息（协议 / baseUrl / 路径）；仅管理员 */
  editable: boolean;
}

interface ProviderTest {
  ok: boolean;
  providerId: string;
  model: string;
  endpoint: string;
  latencyMs: number;
  keySource: "own" | "platform";
  reply?: string;
  error?: string;
}

interface ProviderResponse {
  activeProviderId: string;
  defaultProviderId: string;
  providers: ProviderStatus[];
  allProviders: ProviderStatus[];
  isAdmin: boolean;
  definitionsEditable: boolean;
}

interface EditDraft {
  label: string;
  protocol: Protocol;
  baseUrl: string;
  path: string;
  maxOutputTokens: string;
  timeoutMs: string;
  keyStrategy: ProviderStatus["keyStrategy"];
  enabled: boolean;
}

interface CreateDraft {
  id: string;
  label: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const PROTOCOL_LABEL: Record<Protocol, string> = {
  "openai-chat": "OpenAI · chat/completions",
  "openai-responses": "OpenAI · responses",
  "anthropic-messages": "Anthropic · messages",
};

const EMPTY_CREATE: CreateDraft = {
  id: "",
  label: "",
  protocol: "openai-chat",
  baseUrl: "",
  model: "",
  apiKey: "",
};

function draftFrom(provider: ProviderStatus): EditDraft {
  return {
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    path: provider.path,
    maxOutputTokens: String(provider.maxOutputTokens ?? ""),
    timeoutMs: String(provider.timeoutMs ?? ""),
    keyStrategy: provider.keyStrategy,
    enabled: provider.enabled,
  };
}

export function AiProviderSettings() {
  const t = useTranslations("settings.aiProviders");
  const [data, setData] = useState<ProviderResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<ProviderTest | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);

  const [modelInputs, setModelInputs] = useState<Record<string, string>>({});
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});

  const applySnapshot = useCallback((payload: Partial<ProviderResponse>) => {
    setData((current) => (current ? { ...current, ...payload } : (payload as ProviderResponse)));
    const list = payload.allProviders ?? payload.providers;
    if (list) {
      setModelInputs((current) => {
        const next: Record<string, string> = { ...current };
        for (const provider of list) next[provider.id] = provider.effectiveModel ?? "";
        return next;
      });
    }
    setKeyInputs({});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/ai-provider", { cache: "no-store" });
      if (res.ok) applySnapshot(await res.json());
    } catch (error) {
      console.error("Failed to load providers:", error);
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 统一请求：成功时合并服务端返回的最新快照 */
  const send = useCallback(
    async (
      method: "POST" | "PUT" | "DELETE",
      body?: Record<string, unknown>,
      query = "",
      successText?: string,
    ): Promise<Record<string, unknown> | null> => {
      const res = await fetch(`/api/settings/ai-provider${query}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMessage({ type: "error", text: payload.error || t("switchFailed") });
        return null;
      }

      const { isAdmin: _isAdmin, protocols: _protocols, ...snapshot } = payload;
      applySnapshot(snapshot as Partial<ProviderResponse>);
      if (successText) setMessage({ type: "success", text: successText });
      return payload as Record<string, unknown>;
    },
    [applySnapshot, t],
  );

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setMessage(null);
    setTestResult(null);
    try {
      await task();
    } catch (error) {
      console.error(error);
      setMessage({ type: "error", text: t("switchFailed") });
    } finally {
      setBusy(null);
    }
  };

  const activate = (provider: ProviderStatus) =>
    run(`activate:${provider.id}`, async () => {
      await send("POST", { providerId: provider.id }, "", t("switchSuccess", { name: provider.label }));
    });

  const resetActive = () =>
    run("__reset__", async () => {
      await send("DELETE", undefined, "", t("resetSuccess"));
    });

  const saveModel = (provider: ProviderStatus) =>
    run(`model:${provider.id}`, async () => {
      const model = (modelInputs[provider.id] ?? "").trim();
      if (!model) return;
      await send("POST", { action: "set-model", providerId: provider.id, model }, "", t("modelSaved"));
    });

  const saveKey = (provider: ProviderStatus) =>
    run(`key:${provider.id}`, async () => {
      const apiKey = (keyInputs[provider.id] ?? "").trim();
      if (!apiKey) return;
      await send("POST", { action: "set-key", providerId: provider.id, apiKey }, "", t("keySaved"));
    });

  const clearKey = (provider: ProviderStatus) =>
    run(`clear-key:${provider.id}`, async () => {
      await send("POST", { action: "set-key", providerId: provider.id, clear: true }, "", t("keyCleared"));
    });

  const test = (provider: ProviderStatus) =>
    run(`test:${provider.id}`, async () => {
      const payload = await send("POST", { action: "test", providerId: provider.id });
      if (payload?.test) setTestResult(payload.test as ProviderTest);
    });

  const startEdit = (provider: ProviderStatus) => {
    setEditingId(provider.id);
    setEditDraft(draftFrom(provider));
    setMessage(null);
  };

  const saveEdit = (provider: ProviderStatus) =>
    run(`edit:${provider.id}`, async () => {
      if (!editDraft) return;
      const body: Record<string, unknown> = {
        id: provider.id,
        label: editDraft.label.trim() || provider.id,
        protocol: editDraft.protocol,
        baseUrl: editDraft.baseUrl.trim(),
        path: editDraft.path.trim() || undefined,
        keyStrategy: editDraft.keyStrategy,
        enabled: editDraft.enabled,
      };
      const maxTokens = Number(editDraft.maxOutputTokens);
      const timeout = Number(editDraft.timeoutMs);
      if (Number.isFinite(maxTokens) && maxTokens > 0) body.maxOutputTokens = Math.floor(maxTokens);
      if (Number.isFinite(timeout) && timeout > 0) body.timeoutMs = Math.floor(timeout);

      const ok = await send("PUT", body, "", t("saved"));
      if (ok) {
        setEditingId(null);
        setEditDraft(null);
      }
    });

  const createProvider = () =>
    run("__create__", async () => {
      const { id, label, protocol, baseUrl, model, apiKey } = createDraft;
      if (!id.trim() || !baseUrl.trim()) {
        setMessage({ type: "error", text: t("requiredHint") });
        return;
      }
      const body: Record<string, unknown> = {
        id: id.trim(),
        label: label.trim() || id.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        createOnly: true,
      };
      if (model.trim()) body.model = model.trim();
      if (apiKey.trim()) body.apiKey = apiKey.trim();

      const ok = await send("PUT", body, "", t("created"));
      if (ok) {
        setShowCreate(false);
        setCreateDraft(EMPTY_CREATE);
      }
    });

  const removeProvider = (provider: ProviderStatus) => {
    const confirmText = provider.custom
      ? t("deleteConfirm", { name: provider.label })
      : t("resetProviderConfirm", { name: provider.label });
    if (!confirm(confirmText)) return;

    return run(`delete:${provider.id}`, async () => {
      await send("DELETE", undefined, `?providerId=${encodeURIComponent(provider.id)}`, provider.custom
        ? t("deleted")
        : t("resetProviderDone"));
    });
  };

  const keyStatus = (provider: ProviderStatus) => {
    if (provider.hasOwnKey) return `${t("keyMine")} ${provider.keyHint ?? ""}`.trim();
    if (provider.hasPlatformKey) return t("keyPlatform");
    if (provider.keyStrategy === "user") return t("keyFromUser");
    return t("keyMissing");
  };

  const list = data?.allProviders ?? [];
  // 内置提供商的连接信息只有管理员能改；模型 / Key / 启用状态谁都能改自己的
  const canEditDefinitions = Boolean(data?.definitionsEditable);

  return (
    <Card className="bg-[#F5F3EC] border-[#D8D5CC]">
      <CardHeader>
        <CardTitle style={{ fontFamily: "var(--font-display)" }}>{t("title")}</CardTitle>
        <CardDescription>
          {t("description")}
          {data?.activeProviderId ? ` ${t("current", { id: data.activeProviderId })}` : ""}
        </CardDescription>
        <p className="mt-2 rounded-lg bg-[#D97757]/5 px-3 py-2 text-xs text-[#6B6860]">
          {t("privateHint")}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <>
            {list.map((provider) => (
              <div
                key={provider.id}
                className={`rounded-xl border bg-white p-4 transition-colors ${
                  provider.active ? "border-[#D97757]" : "border-[#D8D5CC]"
                } ${provider.enabled ? "" : "opacity-70"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[#141413]" style={{ fontFamily: "var(--font-heading)" }}>
                        {provider.label}
                      </span>
                      <span className="rounded bg-[#141413]/5 px-2 py-0.5 font-mono text-xs text-[#6B6860]">
                        {PROTOCOL_LABEL[provider.protocol]}
                      </span>
                      {provider.custom && (
                        <span className="rounded bg-[#D97757]/10 px-2 py-0.5 text-xs text-[#D97757]">
                          {t("customBadge")}
                        </span>
                      )}
                      {provider.overriddenFields.length > 0 && (
                        <span className="rounded bg-[#141413]/5 px-2 py-0.5 text-xs text-[#6B6860]">
                          {t("overriddenBadge")}
                        </span>
                      )}
                      {provider.active && (
                        <span className="rounded bg-[#5B8C5A]/10 px-2 py-0.5 text-xs text-[#5B8C5A]">
                          {t("active")}
                        </span>
                      )}
                      {!provider.enabled && (
                        <span className="rounded bg-[#C0453A]/10 px-2 py-0.5 text-xs text-[#C0453A]">
                          {t("disabledLabel")}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 break-all font-mono text-xs text-[#6B6860]">
                      {provider.baseUrl}
                      {provider.path}
                    </p>
                    <p className="mt-1 text-xs text-[#9C9890]">
                      {t("key")}: {keyStatus(provider)}
                      {provider.keyStrategy === "platform" ? ` · ${t("strategyPlatform")}` : ""}
                      {provider.keyStrategy === "user" ? ` · ${t("strategyUser")}` : ""}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {provider.active ? (
                      <span className="text-xs text-[#9C9890]">{t("inUse")}</span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!provider.enabled || busy !== null}
                        onClick={() => activate(provider)}
                        className="border-[#C8C4BC] text-[#6B6860] hover:border-[#D97757] hover:text-[#D97757]"
                      >
                        {busy === `activate:${provider.id}` ? <Spinner size="sm" /> : t("switch")}
                      </Button>
                    )}
                  </div>
                </div>

                {/* 模型：改完保存即生效 */}
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-[220px] flex-1">
                    <label className="mb-1 block text-xs text-[#9C9890]">{t("modelLabel")}</label>
                    <Input
                      value={modelInputs[provider.id] ?? ""}
                      onChange={(event) =>
                        setModelInputs((current) => ({ ...current, [provider.id]: event.target.value }))
                      }
                      placeholder={provider.defaultModel || t("modelPlaceholder")}
                      className="h-9 bg-white font-mono text-xs"
                    />
                  </div>
                  <>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => saveModel(provider)}
                      className="h-9 bg-[#D97757] hover:bg-[#C96848]"
                    >
                      {busy === `model:${provider.id}` ? <Spinner size="sm" /> : t("saveModel")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => test(provider)}
                      className="h-9 border-[#C8C4BC] text-[#6B6860]"
                    >
                      {busy === `test:${provider.id}` ? <Spinner size="sm" /> : t("test")}
                    </Button>
                  </>
                </div>

                {/* Key：只有自己能看到和修改；留空表示不修改 */}
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-[220px] flex-1">
                    <label className="mb-1 block text-xs text-[#9C9890]">{t("apiKey")}</label>
                    <Input
                      type="password"
                      value={keyInputs[provider.id] ?? ""}
                      onChange={(event) =>
                        setKeyInputs((current) => ({ ...current, [provider.id]: event.target.value }))
                      }
                      placeholder={provider.hasOwnKey ? t("apiKeyKeepHint") : t("apiKeyPlaceholder")}
                      className="h-9 bg-white font-mono text-xs"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => saveKey(provider)}
                    className="h-9 border-[#C8C4BC] text-[#6B6860]"
                  >
                    {busy === `key:${provider.id}` ? <Spinner size="sm" /> : t("saveKey")}
                  </Button>
                  {provider.hasOwnKey && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => clearKey(provider)}
                      className="h-9 border-[#C8C4BC] text-[#6B6860] hover:border-[#C0453A] hover:text-[#C0453A]"
                    >
                      {busy === `clear-key:${provider.id}` ? <Spinner size="sm" /> : t("clearKey")}
                    </Button>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#E8E5DC] pt-3">
                  {canEditDefinitions && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => (editingId === provider.id ? setEditingId(null) : startEdit(provider))}
                      className="h-8 text-xs text-[#6B6860]"
                    >
                      {editingId === provider.id ? t("cancel") : t("edit")}
                    </Button>
                  )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => removeProvider(provider)}
                      className="h-8 text-xs text-[#9C9890] hover:text-[#C0453A]"
                    >
                      {busy === `delete:${provider.id}` ? (
                        <Spinner size="sm" />
                      ) : provider.custom ? (
                        t("deleteProvider")
                      ) : (
                        t("resetProvider")
                      )}
                    </Button>
                  </div>

                {editingId === provider.id && editDraft && (
                  <div className="mt-3 grid grid-cols-1 gap-3 rounded-lg bg-[#FAF9F5] p-3 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs text-[#9C9890]">{t("providerLabel")}</label>
                      <Input
                        value={editDraft.label}
                        onChange={(event) => setEditDraft({ ...editDraft, label: event.target.value })}
                        className="h-9 bg-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-[#9C9890]">{t("protocol")}</label>
                      <select
                        value={editDraft.protocol}
                        onChange={(event) =>
                          setEditDraft({ ...editDraft, protocol: event.target.value as Protocol })
                        }
                        className="h-9 w-full rounded-lg border border-[#C8C4BC] bg-white px-3 text-sm text-[#141413] outline-none"
                      >
                        {(Object.keys(PROTOCOL_LABEL) as Protocol[]).map((protocol) => (
                          <option key={protocol} value={protocol}>
                            {PROTOCOL_LABEL[protocol]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className="mb-1 block text-xs text-[#9C9890]">{t("baseUrl")}</label>
                      <Input
                        value={editDraft.baseUrl}
                        onChange={(event) => setEditDraft({ ...editDraft, baseUrl: event.target.value })}
                        className="h-9 bg-white font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-[#9C9890]">{t("path")}</label>
                      <Input
                        value={editDraft.path}
                        onChange={(event) => setEditDraft({ ...editDraft, path: event.target.value })}
                        placeholder="/chat/completions"
                        className="h-9 bg-white font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-[#9C9890]">{t("keyStrategy")}</label>
                      <select
                        value={editDraft.keyStrategy}
                        onChange={(event) =>
                          setEditDraft({
                            ...editDraft,
                            keyStrategy: event.target.value as ProviderStatus["keyStrategy"],
                          })
                        }
                        className="h-9 w-full rounded-lg border border-[#C8C4BC] bg-white px-3 text-sm text-[#141413] outline-none"
                      >
                        <option value="either">{t("strategyEither")}</option>
                        <option value="platform">{t("strategyPlatform")}</option>
                        <option value="user">{t("strategyUser")}</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-[#9C9890]">{t("maxOutputTokens")}</label>
                      <Input
                        type="number"
                        value={editDraft.maxOutputTokens}
                        onChange={(event) => setEditDraft({ ...editDraft, maxOutputTokens: event.target.value })}
                        className="h-9 bg-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-[#9C9890]">{t("timeoutMs")}</label>
                      <Input
                        type="number"
                        value={editDraft.timeoutMs}
                        onChange={(event) => setEditDraft({ ...editDraft, timeoutMs: event.target.value })}
                        className="h-9 bg-white text-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2 md:col-span-2">
                      <input
                        id={`enabled-${provider.id}`}
                        type="checkbox"
                        checked={editDraft.enabled}
                        onChange={(event) => setEditDraft({ ...editDraft, enabled: event.target.checked })}
                        className="h-4 w-4 accent-[#D97757]"
                      />
                      <label htmlFor={`enabled-${provider.id}`} className="text-xs text-[#6B6860]">
                        {t("enabledLabel")}
                      </label>
                      <div className="ml-auto flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingId(null);
                            setEditDraft(null);
                          }}
                          className="h-8 border-[#C8C4BC] text-[#6B6860]"
                        >
                          {t("cancel")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => saveEdit(provider)}
                          className="h-8 bg-[#D97757] hover:bg-[#C96848]"
                        >
                          {busy === `edit:${provider.id}` ? <Spinner size="sm" /> : t("save")}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* 新增提供商（只对自己可见） */}
            <div className="rounded-xl border border-dashed border-[#C8C4BC] bg-white/50 p-4">
              {!showCreate ? (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="text-sm text-[#D97757] hover:underline"
                >
                  + {t("addProvider")}
                </button>
              ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-[#9C9890]">{t("newProviderHint")}</p>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs text-[#9C9890]">{t("providerId")}</label>
                        <Input
                          value={createDraft.id}
                          onChange={(event) => setCreateDraft({ ...createDraft, id: event.target.value })}
                          placeholder="my-gateway"
                          className="h-9 bg-white font-mono text-xs"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-[#9C9890]">{t("providerLabel")}</label>
                        <Input
                          value={createDraft.label}
                          onChange={(event) => setCreateDraft({ ...createDraft, label: event.target.value })}
                          placeholder="My Gateway"
                          className="h-9 bg-white text-sm"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-[#9C9890]">{t("protocol")}</label>
                        <select
                          value={createDraft.protocol}
                          onChange={(event) =>
                            setCreateDraft({ ...createDraft, protocol: event.target.value as Protocol })
                          }
                          className="h-9 w-full rounded-lg border border-[#C8C4BC] bg-white px-3 text-sm text-[#141413] outline-none"
                        >
                          {(Object.keys(PROTOCOL_LABEL) as Protocol[]).map((protocol) => (
                            <option key={protocol} value={protocol}>
                              {PROTOCOL_LABEL[protocol]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-[#9C9890]">{t("modelLabel")}</label>
                        <Input
                          value={createDraft.model}
                          onChange={(event) => setCreateDraft({ ...createDraft, model: event.target.value })}
                          placeholder="gpt-4o-mini"
                          className="h-9 bg-white font-mono text-xs"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="mb-1 block text-xs text-[#9C9890]">{t("baseUrl")}</label>
                        <Input
                          value={createDraft.baseUrl}
                          onChange={(event) => setCreateDraft({ ...createDraft, baseUrl: event.target.value })}
                          placeholder="https://llm.example.com/v1"
                          className="h-9 bg-white font-mono text-xs"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="mb-1 block text-xs text-[#9C9890]">{t("apiKey")}</label>
                        <Input
                          type="password"
                          value={createDraft.apiKey}
                          onChange={(event) => setCreateDraft({ ...createDraft, apiKey: event.target.value })}
                          placeholder={t("apiKeyPlaceholder")}
                          className="h-9 bg-white font-mono text-xs"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setShowCreate(false);
                          setCreateDraft(EMPTY_CREATE);
                        }}
                        className="h-8 border-[#C8C4BC] text-[#6B6860]"
                      >
                        {t("cancel")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={createProvider}
                        className="h-8 bg-[#D97757] hover:bg-[#C96848]"
                      >
                        {busy === "__create__" ? <Spinner size="sm" /> : t("create")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

            {!canEditDefinitions && <p className="text-xs text-[#9C9890]">{t("adminOnly")}</p>}

            {data && data.activeProviderId !== data.defaultProviderId && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={resetActive}
                className="border-[#C8C4BC] text-[#6B6860]"
              >
                {busy === "__reset__" ? <Spinner size="sm" /> : t("reset")}
              </Button>
            )}
          </>
        )}

        {testResult && (
          <div
            className={`rounded-lg p-3 text-xs ${
              testResult.ok ? "bg-[#5B8C5A]/10 text-[#5B8C5A]" : "bg-[#C0453A]/10 text-[#C0453A]"
            }`}
          >
            {testResult.ok
              ? t("testOk", { model: testResult.model, ms: testResult.latencyMs })
              : t("testFail", { error: testResult.error ?? "" })}
            <span className="ml-2 opacity-70">
              ({t(testResult.keySource === "own" ? "keyMine" : "keyPlatform")})
            </span>
            {testResult.ok && testResult.reply ? (
              <span className="ml-2 font-mono opacity-80">{testResult.reply}</span>
            ) : null}
          </div>
        )}

        {message && (
          <div
            className={`rounded-lg p-3 text-sm ${
              message.type === "success"
                ? "bg-[#5B8C5A]/10 text-[#5B8C5A]"
                : "bg-[#C0453A]/10 text-[#C0453A]"
            }`}
          >
            {message.text}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
