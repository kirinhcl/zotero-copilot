import { getCredential, getAccessToken, isOAuthExpired } from "../auth/storage";
import {
  getOpenAIAccessToken,
  isOpenAIOAuthActive,
  getAnthropicAccessToken,
  isAnthropicOAuthActive,
} from "../auth/oauth";
import { getProvider, type ProviderId, type AuthMode } from "./providers";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamCallbacks {
  onChunk: (fullText: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

function getActiveProviderId(): ProviderId {
  const raw = Zotero.Prefs.get(
    "extensions.zotero.zoterocopliot.provider",
    true,
  ) as string | undefined;
  if (
    raw === "openai" ||
    raw === "anthropic" ||
    raw === "gemini" ||
    raw === "custom"
  ) {
    return raw;
  }
  return "openai";
}

function getActiveModel(providerId: ProviderId): string {
  const prefKey = `extensions.zotero.zoterocopliot.${providerId}.model`;
  const model = (Zotero.Prefs.get(prefKey, true) as string | undefined)?.trim();
  return model || getProvider(providerId).defaultModel;
}

function getAuthMode(providerId: ProviderId): AuthMode {
  if (providerId === "openai" && isOpenAIOAuthActive()) return "oauth";
  if (providerId === "anthropic" && isAnthropicOAuthActive()) return "oauth";
  return "api";
}

async function resolveToken(
  providerId: ProviderId,
  authMode: AuthMode,
): Promise<{ token: string; accountId?: string }> {
  if (providerId === "openai" && authMode === "oauth") {
    const token = await getOpenAIAccessToken();
    const cred = getCredential("openai-oauth");
    const accountId = cred?.type === "oauth" ? cred.accountId : undefined;
    return { token, accountId };
  }

  if (providerId === "anthropic" && authMode === "oauth") {
    const token = await getAnthropicAccessToken();
    return { token };
  }

  const token = getAccessToken(providerId);
  if (!token) {
    throw new Error(
      `No API key configured for ${getProvider(providerId).label}. ` +
        "Open Zotero Copilot preferences to set up authentication.",
    );
  }
  return { token };
}

export function streamChat(
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
): { abort: () => void } {
  let isDone = false;
  let isAborted = false;
  let requestCanceller: (() => void) | null = null;

  const finish = (text: string) => {
    if (isDone || isAborted) return;
    isDone = true;
    callbacks.onDone(text);
  };

  const fail = (error: Error) => {
    if (isDone || isAborted) return;
    isDone = true;
    callbacks.onError(error);
  };

  const providerId = getActiveProviderId();
  const provider = getProvider(providerId);
  const authMode = getAuthMode(providerId);
  const model = getActiveModel(providerId);
  const maxTokensRaw = Zotero.Prefs.get(
    "extensions.zotero.zoterocopliot.maxTokens",
    true,
  ) as number | undefined;
  const maxTokens = Number.isFinite(maxTokensRaw)
    ? (maxTokensRaw as number)
    : 4096;
  const tempRaw = Zotero.Prefs.get(
    "extensions.zotero.zoterocopliot.temperature",
    true,
  ) as string | undefined;
  const temperature = Number.isFinite(Number.parseFloat(tempRaw || ""))
    ? Number.parseFloat(tempRaw!)
    : 0.7;

  resolveToken(providerId, authMode)
    .then(({ token, accountId }) => {
      if (isAborted) return;

      const url = provider.buildEndpoint(authMode);
      const headers = provider.buildHeaders(token, authMode, accountId);
      const body = provider.formatBody(
        model,
        messages,
        maxTokens,
        temperature,
        authMode,
      );

      let accumulated = "";
      let partialBuffer = "";
      let processedLength = 0;
      let currentEvent = "";

      const processSSEData = (raw: string) => {
        partialBuffer += raw;
        const lines = partialBuffer.split(/\r?\n/);
        partialBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed) {
            currentEvent = "";
            continue;
          }

          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
            continue;
          }

          let dataPayload = trimmed;
          if (trimmed.startsWith("data:")) {
            dataPayload = trimmed.slice(5).trim();
          }

          const result = provider.parseSSEChunk(
            currentEvent,
            dataPayload,
            authMode,
          );
          currentEvent = "";

          if (result.error) {
            fail(new Error(result.error));
            return;
          }
          if (result.content) {
            accumulated += result.content;
            callbacks.onChunk(accumulated);
          }
          if (result.done) {
            finish(accumulated);
            return;
          }
        }
      };

      Zotero.HTTP.request("POST", url, {
        body,
        headers,
        timeout: 60000,
        requestObserver: (xmlhttp: XMLHttpRequest) => {
          xmlhttp.onprogress = () => {
            xmlhttp.timeout = 0;
            const responseText = xmlhttp.responseText || "";
            const next = responseText.slice(processedLength);
            processedLength = responseText.length;
            if (next) processSSEData(next);
          };
          xmlhttp.onerror = () =>
            fail(new Error("Network error while contacting LLM endpoint."));
          xmlhttp.ontimeout = () =>
            fail(
              new Error("Request timeout while waiting for model response."),
            );
          xmlhttp.onabort = () => {
            isAborted = true;
          };
        },
        cancellerReceiver: (cancel: () => void) => {
          requestCanceller = cancel;
        },
      })
        .then((xmlhttp) => {
          if (isDone || isAborted) return;
          const remaining = (xmlhttp.responseText || "").slice(processedLength);
          if (remaining) processSSEData(remaining);

          if (!isDone && partialBuffer.trim()) {
            try {
              const fallback = JSON.parse(partialBuffer.trim());
              const content = extractNonStreamContent(fallback, providerId);
              if (content) {
                accumulated = content;
                callbacks.onChunk(accumulated);
              }
            } catch {
              void 0;
            }
          }
          if (!isDone) finish(accumulated);
        })
        .catch((error: any) => {
          const msg = (error?.message || error?.toString?.() || "").trim();
          fail(new Error(msg || "Failed to call LLM endpoint."));
        });
    })
    .catch((err: any) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

  return {
    abort() {
      isAborted = true;
      requestCanceller?.();
    },
  };
}

function extractNonStreamContent(payload: any, providerId: ProviderId): string {
  if (providerId === "anthropic") {
    const blocks = payload?.content;
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text || "")
        .join("");
    }
    return "";
  }

  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}
