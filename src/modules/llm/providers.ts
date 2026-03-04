export type ProviderId = "openai" | "anthropic" | "gemini" | "custom";

export type AuthMode = "oauth" | "api";

export interface SSEResult {
  content: string;
  done: boolean;
  error?: string;
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  supportsOAuth: boolean;
  defaultModel: string;
  apiKeyUrl: string;
  buildEndpoint: (authMode: AuthMode) => string;
  buildHeaders: (
    token: string,
    authMode: AuthMode,
    accountId?: string,
  ) => Record<string, string>;
  formatBody: (
    model: string,
    messages: Array<{ role: string; content: string }>,
    maxTokens: number,
    temperature: number,
    authMode: AuthMode,
  ) => string;
  parseSSEChunk: (
    eventLine: string,
    dataLine: string,
    authMode: AuthMode,
  ) => SSEResult;
}

function openaiChatCompletionsBody(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
): string {
  return JSON.stringify({
    model,
    stream: true,
    messages,
    max_tokens: maxTokens,
    temperature,
  });
}

function codexResponsesBody(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
): string {
  let instructions = "";
  const input: Array<{ role: string; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      instructions += (instructions ? "\n\n" : "") + msg.content;
    } else {
      input.push(msg);
    }
  }

  const body: Record<string, unknown> = {
    model,
    stream: true,
    store: false,
    instructions: instructions || "You are a helpful research assistant.",
    input,
  };
  return JSON.stringify(body);
}

const EMPTY: SSEResult = { content: "", done: false };

function chatCompletionsParseSSE(
  _eventLine: string,
  dataLine: string,
): SSEResult {
  const data = dataLine.trim();
  if (!data) return EMPTY;
  if (data === "[DONE]") return { content: "", done: true };

  try {
    const parsed = JSON.parse(data);
    if (parsed?.error?.message)
      return { content: "", done: true, error: parsed.error.message };
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) return EMPTY;
    if (typeof delta.content === "string")
      return { content: delta.content, done: false };
    if (Array.isArray(delta.content)) {
      const text = delta.content
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join("");
      return { content: text, done: false };
    }
  } catch {
    void 0;
  }
  return EMPTY;
}

function codexResponsesParseSSE(
  eventLine: string,
  dataLine: string,
): SSEResult {
  const data = dataLine.trim();
  if (!data) return EMPTY;

  try {
    const parsed = JSON.parse(data);
    if (parsed?.error?.message)
      return { content: "", done: true, error: parsed.error.message };

    const evType = eventLine.trim() || parsed?.type || "";
    if (
      evType === "response.output_text.delta" ||
      evType === "response.text.delta"
    ) {
      return {
        content: typeof parsed.delta === "string" ? parsed.delta : "",
        done: false,
      };
    }
    if (evType === "response.completed" || evType === "response.done") {
      return { content: "", done: true };
    }
    if (evType === "error") {
      return {
        content: "",
        done: true,
        error: parsed?.message || "Codex API error",
      };
    }
  } catch {
    void 0;
  }
  return EMPTY;
}

function openaiParseSSE(
  _eventLine: string,
  dataLine: string,
  authMode: AuthMode,
): SSEResult {
  return authMode === "oauth"
    ? codexResponsesParseSSE(_eventLine, dataLine)
    : chatCompletionsParseSSE(_eventLine, dataLine);
}

function openaiFormatBody(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
  authMode: AuthMode,
): string {
  return authMode === "oauth"
    ? codexResponsesBody(model, messages, maxTokens, temperature)
    : openaiChatCompletionsBody(model, messages, maxTokens, temperature);
}

function anthropicFormatBody(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
  _authMode: AuthMode,
): string {
  let system: string | undefined;
  const filtered: Array<{ role: string; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = (system ? system + "\n\n" : "") + msg.content;
    } else {
      filtered.push(msg);
    }
  }

  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages: filtered,
    max_tokens: maxTokens,
    temperature,
  };
  if (system) body.system = system;
  return JSON.stringify(body);
}

function anthropicParseSSE(
  _eventLine: string,
  dataLine: string,
  _authMode: AuthMode,
): SSEResult {
  const data = dataLine.trim();
  if (!data) return EMPTY;

  try {
    const parsed = JSON.parse(data);
    if (parsed.type === "error") {
      return {
        content: "",
        done: true,
        error: parsed.error?.message || "Anthropic API error",
      };
    }
    if (
      parsed.type === "content_block_delta" &&
      parsed.delta?.type === "text_delta"
    ) {
      return { content: parsed.delta.text || "", done: false };
    }
    if (parsed.type === "message_stop") {
      return { content: "", done: true };
    }
  } catch {
    void 0;
  }
  return EMPTY;
}

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    supportsOAuth: true,
    defaultModel: "o4-mini",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    buildEndpoint(authMode) {
      return authMode === "oauth"
        ? CODEX_ENDPOINT
        : "https://api.openai.com/v1/chat/completions";
    },
    buildHeaders(token, authMode, accountId) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (authMode === "oauth") {
        headers["OpenAI-Beta"] = "responses=experimental";
        headers["originator"] = "zotero-copilot";
        if (accountId) headers["ChatGPT-Account-Id"] = accountId;
      }
      return headers;
    },
    formatBody: openaiFormatBody,
    parseSSEChunk: openaiParseSSE,
  },

  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    supportsOAuth: true,
    defaultModel: "claude-sonnet-4-20250514",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    buildEndpoint(authMode) {
      return authMode === "oauth"
        ? "https://api.anthropic.com/v1/messages?beta=true"
        : "https://api.anthropic.com/v1/messages";
    },
    buildHeaders(token, authMode) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (authMode === "oauth") {
        headers["Authorization"] = `Bearer ${token}`;
        headers["anthropic-beta"] =
          "oauth-2025-04-20,interleaved-thinking-2025-05-14";
        headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
      } else {
        headers["x-api-key"] = token;
      }
      return headers;
    },
    formatBody: anthropicFormatBody,
    parseSSEChunk: anthropicParseSSE,
  },

  gemini: {
    id: "gemini",
    label: "Google Gemini",
    supportsOAuth: false,
    defaultModel: "gemini-2.0-flash",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    buildEndpoint() {
      return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    },
    buildHeaders(token) {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
    },
    formatBody: openaiFormatBody,
    parseSSEChunk: openaiParseSSE,
  },

  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    supportsOAuth: false,
    defaultModel: "gpt-4o-mini",
    apiKeyUrl: "",
    buildEndpoint() {
      const endpoint = (
        (Zotero.Prefs.get(
          "extensions.zotero.zoterocopliot.custom.endpoint",
          true,
        ) as string) || ""
      ).trim();
      const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
      return `${base}/v1/chat/completions`;
    },
    buildHeaders(token) {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
    },
    formatBody: openaiFormatBody,
    parseSSEChunk: openaiParseSSE,
  },
};

export function getProvider(id: ProviderId): ProviderDef {
  return PROVIDERS[id] || PROVIDERS.custom;
}
