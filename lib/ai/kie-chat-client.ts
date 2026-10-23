import {
  KieApiError,
  isKieGatewayTimeout,
  parseKieChatEventStream,
  parseKieChatResponse,
} from "@/lib/ai/kie-chat-response";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface KieChatCompletionOptions {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  fetcher?: Fetcher;
  delay?: (milliseconds: number) => Promise<void>;
}

const REQUEST_DEADLINE_MS = 270_000;
const ATTEMPT_TIMEOUT_MS = 180_000;
const RETRY_DELAY_MS = 750;
const MINIMUM_RETRY_BUDGET_MS = 30_000;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isTransportTimeout(error: unknown): error is Error {
  return error instanceof Error
    && (error.name === "TimeoutError" || error.name === "AbortError");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("KIE Gemini returned invalid JSON");
  }
}

async function requestOnce(
  options: KieChatCompletionOptions,
  timeoutMs: number,
): Promise<string> {
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(options.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify({ ...options.payload, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    if (contentType.includes("application/json")) {
      try {
        parseKieChatResponse(parseJson(body));
      } catch (error) {
        if (error instanceof KieApiError) throw error;
      }
    }
    throw new KieApiError(response.status, response.statusText || "request failed");
  }

  if (contentType.includes("text/event-stream") || body.trimStart().startsWith("data:")) {
    return parseKieChatEventStream(body);
  }

  return parseKieChatResponse(parseJson(body));
}

export async function requestKieChatCompletion(
  options: KieChatCompletionOptions,
): Promise<string> {
  const startedAt = Date.now();
  const delay = options.delay || wait;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = REQUEST_DEADLINE_MS - elapsedMs;
    const timeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, remainingMs);

    try {
      return await requestOnce(options, timeoutMs);
    } catch (error) {
      const retryBudgetMs = REQUEST_DEADLINE_MS - (Date.now() - startedAt);
      const transportTimeout = isTransportTimeout(error);
      const canRetry = attempt === 0
        && (isKieGatewayTimeout(error) || transportTimeout)
        && retryBudgetMs >= MINIMUM_RETRY_BUDGET_MS;

      if (!canRetry) {
        if (transportTimeout) {
          throw new Error(`KIE request timed out after ${attempt + 1} attempts`, {
            cause: error,
          });
        }
        throw error;
      }

      console.warn("[KIE Gemini] Transient timeout; retrying once", {
        kind: isKieGatewayTimeout(error) ? "gateway-524" : "transport-timeout",
        model: typeof options.payload.model === "string" ? options.payload.model : undefined,
      });
      await delay(RETRY_DELAY_MS);
    }
  }

  throw new Error("KIE Gemini retry exhausted");
}
