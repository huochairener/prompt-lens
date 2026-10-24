import { ProxyAgent, setGlobalDispatcher } from "undici";

let initialized = false;

/**
 * 本地开发时把全局 fetch / undici 流量指向代理。
 * 生产环境不做任何处理（Vercel 等平台不需要）。
 */
export function ensureProxyTransport(): void {
  if (initialized) return;
  initialized = true;

  if (process.env.NODE_ENV !== "development") return;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:7897";
  if (!proxyUrl) return;

  try {
    new URL(proxyUrl);
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log("[providers] 本地代理已启用：", proxyUrl);
  } catch {
    console.warn("[providers] 代理地址无法解析，已跳过：", proxyUrl);
  }
}
