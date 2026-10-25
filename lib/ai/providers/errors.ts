import type { ProviderProtocol } from "./types";

/** 配置本身有问题（未知提供商、缺少 base URL、协议不支持等） */
export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** 没有可用的 API Key */
export class ProviderApiKeyError extends Error {
  readonly providerId: string;

  constructor(providerId: string, label: string, envNames: string[]) {
    const hint = envNames.length > 0
      ? `请先在设置页填写你自己的 API Key（管理员也可以改用环境变量 ${envNames.join(" 或 ")}）`
      : "请先在设置页填写你自己的 API Key";
    super(`提供商 ${label} (${providerId}) 缺少 API Key。${hint}。`);
    this.name = "ProviderApiKeyError";
    this.providerId = providerId;
  }
}

export interface ProviderRequestErrorInit {
  providerId: string;
  protocol: ProviderProtocol;
  status?: number;
  code?: string;
  details?: unknown;
  cause?: unknown;
}

/** 上游调用失败（HTTP 非 2xx、响应体报错、超时等） */
export class ProviderRequestError extends Error {
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, init: ProviderRequestErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ProviderRequestError";
    this.providerId = init.providerId;
    this.protocol = init.protocol;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
  }
}
