export type OAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
};

export type ApiKeyCredential = {
  type: "api";
  key: string;
};

export type AuthCredential = OAuthCredential | ApiKeyCredential;

const PREF_PREFIX = "extensions.zotero.zoterocopliot.auth";

function prefKey(providerId: string): string {
  return `${PREF_PREFIX}.${providerId}`;
}

export function getCredential(providerId: string): AuthCredential | null {
  try {
    const raw = Zotero.Prefs.get(prefKey(providerId), true) as
      | string
      | undefined;
    if (!raw) return null;
    return JSON.parse(raw) as AuthCredential;
  } catch {
    return null;
  }
}

export async function setCredential(
  providerId: string,
  credential: AuthCredential,
): Promise<void> {
  Zotero.Prefs.set(prefKey(providerId), JSON.stringify(credential), true);
}

export function removeCredential(providerId: string): void {
  try {
    Zotero.Prefs.clear(prefKey(providerId), true);
  } catch {
    Zotero.Prefs.set(prefKey(providerId), "", true);
  }
}

export function hasCredential(providerId: string): boolean {
  return getCredential(providerId) !== null;
}

export function getAccessToken(providerId: string): string | null {
  const cred = getCredential(providerId);
  if (!cred) return null;
  if (cred.type === "api") return cred.key;
  if (cred.type === "oauth") return cred.access;
  return null;
}

export function isOAuthExpired(providerId: string): boolean {
  const cred = getCredential(providerId);
  if (!cred || cred.type !== "oauth") return false;
  return cred.expires < Date.now();
}

export function migrateFromPrefs(): void {
  try {
    const oldKey = Zotero.Prefs.get(
      "extensions.zotero.zoterocopliot.apiKey",
      true,
    ) as string | undefined;
    if (oldKey && oldKey.trim()) {
      const existing = getCredential("openai");
      if (!existing) {
        setCredential("openai", { type: "api", key: oldKey.trim() });
      }
      Zotero.Prefs.set("extensions.zotero.zoterocopliot.apiKey", "", true);
    }
  } catch {
    void 0;
  }
}
