import { and, desc, eq } from "drizzle-orm";
import { db, userApiKeys } from "@/lib/db";
import { decodeAnalyzeApiKey } from "@/lib/usage/trial-quota";
import { isUserKeyProvider } from "./keys";

/** 从数据库读取用户保存的某提供商 API Key（最新且可解密的记录优先） */
export async function loadUserProviderApiKey(
  userId: string,
  providerId: string,
): Promise<string | null> {
  if (!isUserKeyProvider(providerId)) return null;

  const records = await db.query.userApiKeys.findMany({
    where: and(
      eq(userApiKeys.userId, userId),
      eq(userApiKeys.provider, providerId),
      eq(userApiKeys.isActive, true),
    ),
    orderBy: [desc(userApiKeys.updatedAt), desc(userApiKeys.createdAt)],
  });

  for (const record of records) {
    const apiKey = decodeAnalyzeApiKey(record.apiKey);
    if (apiKey) return apiKey;
  }

  return null;
}
