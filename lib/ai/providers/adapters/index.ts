import { ProviderConfigError } from "../errors";
import type { ProtocolAdapter, ProviderProtocol } from "../types";
import { anthropicMessagesAdapter } from "./anthropic-messages";
import { openAiChatAdapter } from "./openai-chat";
import { openAiResponsesAdapter } from "./openai-responses";

export { anthropicMessagesAdapter, openAiChatAdapter, openAiResponsesAdapter };
export { toOpenAiChatMessages } from "./openai-chat";

const ADAPTERS: Record<ProviderProtocol, ProtocolAdapter> = {
  "openai-chat": openAiChatAdapter,
  "openai-responses": openAiResponsesAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
};

export function getProtocolAdapter(protocol: ProviderProtocol): ProtocolAdapter {
  const adapter = ADAPTERS[protocol];
  if (!adapter) throw new ProviderConfigError(`协议 ${protocol} 还没有适配器实现`);
  return adapter;
}
