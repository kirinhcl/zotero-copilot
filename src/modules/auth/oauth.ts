import { getCredential, setCredential, removeCredential } from "./storage";

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_SCOPES = "openid profile email offline_access";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const OAUTH_PORT = 1455;
const OAUTH_CALLBACK = "/auth/callback";
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}${OAUTH_CALLBACK}`;
const OAUTH_TIMEOUT_MS = 2 * 60 * 1000;

let activeServer: nsIServerSocket | null = null;
let pendingResolve: ((code: string) => void) | null = null;
let pendingReject: ((err: Error) => void) | null = null;
let pendingState: string | null = null;
let timeoutId: ReturnType<typeof setTimeout> | null = null;

function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(43);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(hash) };
}

function successHTML(): string {
  return [
    "<!DOCTYPE html><html><head><meta charset='utf-8'>",
    "<style>body{font-family:system-ui;display:flex;justify-content:center;",
    "align-items:center;height:100vh;margin:0;background:#f5f3ff}",
    ".card{text-align:center;padding:2rem;border-radius:12px;",
    "background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}",
    "h1{color:#4f46e5;font-size:1.5rem}p{color:#6b7280}</style></head>",
    "<body><div class='card'><h1>&#10004; Authorized</h1>",
    "<p>You can close this window and return to Zotero.</p></div>",
    "<script>setTimeout(()=>window.close(),2000)</script></body></html>",
  ].join("");
}

function errorHTML(msg: string): string {
  return [
    "<!DOCTYPE html><html><head><meta charset='utf-8'>",
    "<style>body{font-family:system-ui;display:flex;justify-content:center;",
    "align-items:center;height:100vh;margin:0;background:#fef2f2}",
    ".card{text-align:center;padding:2rem;border-radius:12px;",
    "background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}",
    "h1{color:#dc2626;font-size:1.5rem}p{color:#6b7280}</style></head>",
    `<body><div class='card'><h1>&#10008; Error</h1>`,
    `<p>${msg.replace(/</g, "&lt;")}</p></div></body></html>`,
  ].join("");
}

function clearPending() {
  pendingResolve = null;
  pendingReject = null;
  pendingState = null;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function stopServer() {
  if (activeServer) {
    try { activeServer.close(); } catch { void 0; }
    activeServer = null;
  }
  // Reject any pending promise BEFORE clearing — prevents dangling awaits
  if (pendingReject) {
    pendingReject(new Error("OAuth flow cancelled"));
  }
  clearPending();
}

function parseHttpRequest(raw: string): { method: string; path: string; query: URLSearchParams } {
  const firstLine = raw.split("\r\n")[0] || raw.split("\n")[0] || "";
  const parts = firstLine.split(" ");
  const method = parts[0] || "GET";
  const fullPath = parts[1] || "/";
  const qIdx = fullPath.indexOf("?");
  const path = qIdx >= 0 ? fullPath.slice(0, qIdx) : fullPath;
  const queryStr = qIdx >= 0 ? fullPath.slice(qIdx + 1) : "";
  return { method, path, query: new URLSearchParams(queryStr) };
}

function buildHttpResponse(status: number, statusText: string, contentType: string, body: string): string {
  const headers = [
    `HTTP/1.1 ${status} ${statusText}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${new TextEncoder().encode(body).length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return headers + body;
}

function startCallbackServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      server.init(OAUTH_PORT, true, 1);
      activeServer = server;

      server.asyncListen({
        onSocketAccepted(_serv: nsIServerSocket, transport: nsISocketTransport) {
          const input = transport.openInputStream(0, 0, 0);
          const sInput = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
          sInput.init(input);
          const output = transport.openOutputStream(0, 0, 0);

          const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
          pump.init(input, 0, 0, false);

          pump.asyncRead({
            onStartRequest() {},
            onDataAvailable(_req: any, stream: nsIInputStream, _offset: number, count: number) {
              const data = sInput.read(count);
              const { path, query } = parseHttpRequest(data);

              let responseBody: string;
              if (path === OAUTH_CALLBACK) {
                const code = query.get("code");
                const state = query.get("state");
                const error = query.get("error");

                if (error) {
                  responseBody = buildHttpResponse(200, "OK", "text/html", errorHTML(error));
                  pendingReject?.(new Error(error));
                  clearPending();
                } else if (code && state && state === pendingState) {
                  responseBody = buildHttpResponse(200, "OK", "text/html", successHTML());
                  pendingResolve?.(code);
                  clearPending();
                } else {
                  responseBody = buildHttpResponse(400, "Bad Request", "text/html", errorHTML("Invalid callback"));
                }
              } else {
                responseBody = buildHttpResponse(404, "Not Found", "text/plain", "Not Found");
              }

              const encoded = new TextEncoder().encode(responseBody);
              output.write(responseBody, encoded.length);
              output.close();
              input.close();

              setTimeout(() => stopServer(), 500);
            },
            onStopRequest() {},
          });
        },
        onStopListening() {},
      });

      resolve();
    } catch (err: any) {
      reject(new Error(`Failed to start OAuth callback server on port ${OAUTH_PORT}: ${err?.message || err}`));
    }
  });
}

function extractAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) return undefined;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(padded));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  issuer: string,
  clientId: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }).toString();

  const xhr = await Zotero.HTTP.request("POST", `${issuer}/oauth/token`, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  const data = JSON.parse(xhr.responseText || "{}");
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

async function refreshToken(
  refreshTok: string,
  issuer: string,
  clientId: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTok,
    client_id: clientId,
  }).toString();

  const xhr = await Zotero.HTTP.request("POST", `${issuer}/oauth/token`, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  const data = JSON.parse(xhr.responseText || "{}");
  if (data.error) throw new Error(data.error_description || data.error);
  return data;
}

async function doOAuthPKCEFlow(
  issuer: string,
  clientId: string,
  scopes: string,
  credentialKey: string,
  extraAuthParams?: Record<string, string>,
  extractExtra?: (token: string) => Record<string, unknown>,
): Promise<void> {
  stopServer();
  await startCallbackServer();

  const { verifier, challenge } = await generatePKCE();
  const state = randomString(32);

  const authUrl = new URL(`${issuer}/oauth/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (extraAuthParams) {
    for (const [k, v] of Object.entries(extraAuthParams)) {
      authUrl.searchParams.set(k, v);
    }
  }

  const codePromise = new Promise<string>((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    pendingState = state;
    timeoutId = setTimeout(() => {
      pendingReject?.(new Error("OAuth authorization timed out after 5 minutes"));
      stopServer();
    }, OAUTH_TIMEOUT_MS);
  });

  Zotero.launchURL(authUrl.toString());
  const code = await codePromise;

  const tokens = await exchangeCodeForTokens(code, verifier, issuer, clientId, REDIRECT_URI);
  const extra = extractExtra?.(tokens.access_token) ?? {};

  await setCredential(credentialKey, {
    type: "oauth",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: (extra.accountId as string) || undefined,
  });
}

// ── OpenAI ──

export async function startOpenAIOAuth(): Promise<void> {
  return doOAuthPKCEFlow(
    OPENAI_ISSUER,
    OPENAI_CLIENT_ID,
    OPENAI_SCOPES,
    "openai-oauth",
    {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "zotero-copilot",
    },
    (token) => ({ accountId: extractAccountId(token) }),
  );
}

export async function refreshOpenAIToken(): Promise<string> {
  const cred = getCredential("openai-oauth");
  if (!cred || cred.type !== "oauth") throw new Error("No OpenAI OAuth credential");

  const data = await refreshToken(cred.refresh, OPENAI_ISSUER, OPENAI_CLIENT_ID);
  const accountId = extractAccountId(data.access_token);

  await setCredential("openai-oauth", {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token || cred.refresh,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
    accountId: accountId || cred.accountId,
  });
  return data.access_token;
}

export function cancelOAuthFlow(): void { stopServer(); }
export function signOutOpenAI(): void { removeCredential("openai-oauth"); }
export function isOpenAIOAuthActive(): boolean {
  const c = getCredential("openai-oauth");
  return c !== null && c.type === "oauth";
}

export async function getOpenAIAccessToken(): Promise<string> {
  const cred = getCredential("openai-oauth");
  if (!cred || cred.type !== "oauth") throw new Error("Not signed in with OpenAI");
  if (cred.expires < Date.now() + 60_000) return refreshOpenAIToken();
  return cred.access;
}

export function getOpenAIAccountId(): string | undefined {
  const cred = getCredential("openai-oauth");
  return cred?.type === "oauth" ? cred.accountId : undefined;
}

export const OPENAI_CODEX_ENDPOINT = CODEX_API_ENDPOINT;

// ── Anthropic ──

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_AUTH_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code";
export const ANTHROPIC_OAUTH_API_ENDPOINT = "https://api.anthropic.com/v1/messages?beta=true";

export async function startAnthropicOAuth(promptWindow: Window): Promise<void> {
  const { verifier, challenge } = await generatePKCE();

  const authUrl = new URL(ANTHROPIC_AUTH_URL);
  authUrl.searchParams.set("code", "true");
  authUrl.searchParams.set("client_id", ANTHROPIC_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", ANTHROPIC_REDIRECT_URI);
  authUrl.searchParams.set("scope", ANTHROPIC_SCOPES);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", verifier);

  Zotero.launchURL(authUrl.toString());

  const rawCode = await promptForCode(promptWindow);
  if (!rawCode) throw new Error("Authorization cancelled");

  const splits = rawCode.trim().split("#");
  const code = splits[0];
  const codeState = splits[1] || verifier;

  const xhr = await Zotero.HTTP.request("POST", ANTHROPIC_TOKEN_URL, {
    body: JSON.stringify({
      code,
      state: codeState,
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: verifier,
    }),
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  const data = JSON.parse(xhr.responseText || "{}");
  if (data.error) throw new Error(data.error_description || data.error);

  await setCredential("anthropic-oauth", {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in ?? 28800) * 1000,
  });
}

function promptForCode(win: Window): Promise<string | null> {
  return new Promise((resolve) => {
    const input: any = { value: "" };
    const ok = (Services.prompt as any).prompt(
      win,
      "Anthropic Authorization",
      "Paste the authorization code from your browser:",
      input,
      "",
      { value: false },
    );
    resolve(ok ? input.value : null);
  });
}

export async function refreshAnthropicToken(): Promise<string> {
  const cred = getCredential("anthropic-oauth");
  if (!cred || cred.type !== "oauth") throw new Error("No Anthropic OAuth credential");

  const xhr = await Zotero.HTTP.request("POST", ANTHROPIC_TOKEN_URL, {
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: cred.refresh,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  const data = JSON.parse(xhr.responseText || "{}");
  if (data.error) throw new Error(data.error_description || data.error);

  await setCredential("anthropic-oauth", {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token || cred.refresh,
    expires: Date.now() + (data.expires_in ?? 28800) * 1000,
  });
  return data.access_token;
}

export function signOutAnthropic(): void { removeCredential("anthropic-oauth"); }
export function isAnthropicOAuthActive(): boolean {
  const c = getCredential("anthropic-oauth");
  return c !== null && c.type === "oauth";
}

export async function getAnthropicAccessToken(): Promise<string> {
  const cred = getCredential("anthropic-oauth");
  if (!cred || cred.type !== "oauth") throw new Error("Not signed in with Anthropic");
  if (cred.expires < Date.now() + 60_000) return refreshAnthropicToken();
  return cred.access;
}

// ── Cleanup ──

export function registerOAuthCallback(): void {
  /* server starts on-demand per flow, no persistent registration needed */
}

export function unregisterOAuthCallback(): void {
  stopServer();
}
