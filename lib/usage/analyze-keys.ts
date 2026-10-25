import { decryptApiKey, isValidEncryptedKey } from "@/lib/utils/encryption";

/**
 * 解析用户保存在 `user_api_keys` 里的 Key。
 *
 * 兼容两种情况：新写入的是加密串，历史数据可能是明文。解不出来就当没有 Key。
 */
export function decodeAnalyzeApiKey(storedApiKey: string): string | null {
  const trimmed = storedApiKey.trim();
  if (!trimmed) return null;
  if (!isValidEncryptedKey(trimmed)) return trimmed;

  try {
    return decryptApiKey(trimmed).trim() || null;
  } catch {
    return null;
  }
}
