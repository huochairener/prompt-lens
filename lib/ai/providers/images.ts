const DATA_URL_PATTERN = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

export interface ImagePayload {
  mimeType: string;
  base64: string;
  dataUrl: string;
}

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

export function parseDataUrl(value: string): ImagePayload | null {
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) return null;

  const mimeType = (match[1] || "image/jpeg").toLowerCase();
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const base64 = isBase64
    ? payload.replace(/\s+/g, "")
    : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");

  return {
    mimeType,
    base64,
    dataUrl: `data:${mimeType};base64,${base64}`,
  };
}

export interface LoadImageOptions {
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 把 data URL 或 http(s) URL 统一加载为 base64。
 * Anthropic 协议只接受 base64 图片，因此需要真正下载远程图片。
 */
export async function loadImagePayload(
  image: string,
  options: LoadImageOptions = {},
): Promise<ImagePayload> {
  const direct = parseDataUrl(image);
  if (direct) return direct;

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const response = await fetchImpl(image, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`图片加载失败（HTTP ${response.status}）：${image.slice(0, 120)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`图片体积超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已拒绝`);
  }

  const mimeType = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const base64 = buffer.toString("base64");

  return { mimeType, base64, dataUrl: `data:${mimeType};base64,${base64}` };
}
