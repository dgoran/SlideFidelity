/**
 * Session and entitlement cache (U15 approach 2). `localStorage` with try/catch; when storage throws
 * (blocked third-party storage, private mode, quota) it switches to memory for the rest of this pane
 * load, so the user stays signed in for the session only.
 */

export interface StoredSession {
  token: string;
  account: { id: string; email: string; /** Epoch ms. */ trialEndsAt: number };
  /** Epoch ms when the session itself expires. */
  expiresAt?: number;
}

export interface SessionStore {
  loadSession(): StoredSession | null;
  saveSession(session: StoredSession): void;
  loadEntitlement(): string | null;
  saveEntitlement(token: string | null): void;
  clear(): void;
  /** False once storage has failed: state will not survive a reload. */
  readonly persistent: boolean;
}

export const SESSION_STORAGE_KEY = "slidecheck:session";
export const ENTITLEMENT_STORAGE_KEY = "slidecheck:entitlement";

function parseSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSession> | null;
    const a = v?.account;
    if (
      !v ||
      typeof v.token !== "string" ||
      !v.token ||
      !a ||
      typeof a.id !== "string" ||
      typeof a.email !== "string" ||
      typeof a.trialEndsAt !== "number"
    ) {
      return null;
    }
    return {
      token: v.token,
      account: { id: a.id, email: a.email, trialEndsAt: a.trialEndsAt },
      ...(typeof v.expiresAt === "number" ? { expiresAt: v.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

export function createSessionStore(getStorage: () => Storage = () => window.localStorage): SessionStore {
  const memory = new Map<string, string>();
  let persistent = true;

  // Every storage read is mirrored into memory, so a later storage failure keeps what was known.
  function storage(): Storage | null {
    if (!persistent) return null;
    try {
      return getStorage();
    } catch {
      persistent = false;
      return null;
    }
  }

  function get(key: string): string | null {
    const s = storage();
    if (s) {
      try {
        const v = s.getItem(key);
        if (v === null) memory.delete(key);
        else memory.set(key, v);
      } catch {
        persistent = false;
      }
    }
    return memory.get(key) ?? null;
  }

  function set(key: string, value: string | null): void {
    const s = storage();
    if (value === null) memory.delete(key);
    else memory.set(key, value);
    if (!s) return;
    try {
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
    } catch {
      persistent = false;
    }
  }

  return {
    loadSession: () => parseSession(get(SESSION_STORAGE_KEY)),
    saveSession: (session) => set(SESSION_STORAGE_KEY, JSON.stringify(session)),
    loadEntitlement: () => get(ENTITLEMENT_STORAGE_KEY),
    saveEntitlement: (token) => set(ENTITLEMENT_STORAGE_KEY, token),
    clear() {
      set(SESSION_STORAGE_KEY, null);
      set(ENTITLEMENT_STORAGE_KEY, null);
    },
    get persistent() {
      return persistent;
    },
  };
}
