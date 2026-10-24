/**
 * 可配置 AI 提供商层的共享类型定义。
 *
 * 设计要点：
 * - 提供商（provider）只描述“如何连接”：协议、base URL、默认模型、密钥来源。
 * - 协议（protocol）只描述“如何对话”：请求体与响应体的形状。
 * 新增提供商通常只需要在 config/ai-providers.json 里加一条记录。
 */

/** 目前支持的三类对话协议 */
export const PROVIDER_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
] as const;

export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * 密钥来源策略：
 * - platform：只使用服务端环境变量（平台出资）
 * - user：只使用用户在设置中保存的 Key（BYOK）
 * - either（默认）：先用户 Key，后平台 Key
 */
export type ProviderKeyStrategy = "platform" | "user" | "either";

/** config/ai-providers.json 中单条提供商的原始结构（字段可选） */
export interface ProviderConfigInput {
  id: string;
  label?: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** 覆盖协议默认路径，例如 "/chat/completions" */
  path?: string;
  /** 按模型指定绝对路径，优先级高于 path（KIE 这类按模型分通道的服务需要） */
  modelPaths?: Record<string, string>;
  defaultModel?: string;
  /** 直接写入密钥（不推荐，优先用 apiKeyEnv） */
  apiKey?: string;
  /** 读取平台密钥的环境变量名，按优先级排序 */
  apiKeyEnv?: string[];
  headers?: Record<string, string>;
  /** 合并进请求体的额外字段 */
  extraBody?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** openai-chat 协议里表示输出上限的字段名，部分新模型要求 max_completion_tokens */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  temperature?: number;
  timeoutMs?: number;
  /** anthropic-messages 协议的 anthropic-version 头 */
  anthropicVersion?: string;
  keyStrategy?: ProviderKeyStrategy;
  enabled?: boolean;
}

/** 归一化后的提供商配置：默认值已填充，可直接使用 */
export interface ProviderConfig {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  path: string;
  modelPaths: Record<string, string>;
  defaultModel?: string;
  /** 配置文件里内联的密钥（不推荐） */
  apiKey?: string;
  /**
   * 后台在线配置里保存的平台密钥（已解密），优先级最高。
   * 只存在于服务端内存快照中，不会随接口返回给前端。
   */
  secretApiKey?: string;
  /** 在线保存密钥的尾号提示，用于界面展示 */
  secretHint?: string;
  apiKeyEnv: string[];
  headers: Record<string, string>;
  extraBody: Record<string, unknown>;
  maxOutputTokens: number;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  temperature?: number;
  timeoutMs: number;
  anthropicVersion: string;
  keyStrategy: ProviderKeyStrategy;
  enabled: boolean;
  /** 是否为后台在线新增（配置文件里不存在），删除时整条移除 */
  custom: boolean;
  /** 被在线配置显式覆盖的字段名，用于界面提示 */
  overriddenFields: string[];
}

/**
 * 在线编辑的覆盖项，存在数据库 ai_settings.overrides 里。
 *
 * - 与 config/ai-providers.json 同 id 时按字段覆盖（只写需要改的字段）
 * - 文件里没有的 id 表示"在线新增的提供商"，此时 custom=true，需提供完整定义
 * - 切换模型 = 写 defaultModel
 */
export interface ProviderOverride {
  id: string;
  /** 在线新增（文件里不存在），删除时整条移除而不是回退 */
  custom?: boolean;
  label?: string;
  protocol?: ProviderProtocol;
  baseUrl?: string;
  path?: string;
  defaultModel?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  keyStrategy?: ProviderKeyStrategy;
  apiKeyEnv?: string[];
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** 数据库里保存的平台密钥（密文 + 展示用尾号） */
export interface StoredSecret {
  cipher: string;
  /** 掩码提示，例如 "…a1b2" */
  hint: string;
  updatedAt: string;
}

/** 非对话类服务（视频生成、语音转写等）的 base URL 配置 */
export interface ServiceConfigInput {
  id: string;
  label?: string;
  baseUrl: string;
  baseUrlEnv?: string[];
}

export interface ServiceConfig {
  id: string;
  label: string;
  baseUrl: string;
  baseUrlEnv: string[];
}

export interface ProviderConfigFile {
  defaultProvider?: string;
  providers?: ProviderConfigInput[];
  services?: ServiceConfigInput[];
}

export type ChatRole = "system" | "user" | "assistant";

/** 与协议无关的消息内容：文本，或一张图片（data URL / http(s) URL） */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[];
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** 适配器构建请求时拿到的上下文 */
export interface AdapterInput {
  url: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  temperature?: number;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  anthropicVersion?: string;
}

export interface AdapterRequest {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface AdapterResult {
  text: string;
  usage?: TokenUsage;
}

export interface ProtocolAdapter {
  buildRequest(input: AdapterInput): Promise<AdapterRequest>;
  parseResponse(payload: unknown): AdapterResult;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
