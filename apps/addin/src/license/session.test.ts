import { beforeEach, describe, expect, it } from "vitest";
import { ENTITLEMENT_STORAGE_KEY, SESSION_STORAGE_KEY, createSessionStore, type StoredSession } from "./session";

const SESSION: StoredSession = { token: "sess", account: { id: "acct", email: "a@b.co", trialEndsAt: 123 } };

class ThrowingStorage implements Storage {
  length = 0;
  clear(): void {
    throw new DOMException("denied", "SecurityError");
  }
  getItem(): string | null {
    throw new DOMException("denied", "SecurityError");
  }
  key(): string | null {
    return null;
  }
  removeItem(): void {
    throw new DOMException("denied", "SecurityError");
  }
  setItem(): void {
    throw new DOMException("QuotaExceededError", "QuotaExceededError");
  }
}

describe("session store", () => {
  beforeEach(() => localStorage.clear());

  it("persists the session and entitlement in localStorage", () => {
    const store = createSessionStore(() => localStorage);
    store.saveSession(SESSION);
    store.saveEntitlement("tok");
    expect(store.persistent).toBe(true);
    const again = createSessionStore(() => localStorage);
    expect(again.loadSession()).toEqual(SESSION);
    expect(again.loadEntitlement()).toBe("tok");
  });

  it("clear removes both", () => {
    const store = createSessionStore(() => localStorage);
    store.saveSession(SESSION);
    store.saveEntitlement("tok");
    store.clear();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(ENTITLEMENT_STORAGE_KEY)).toBeNull();
    expect(store.loadSession()).toBeNull();
  });

  it("saveEntitlement(null) removes the cached token", () => {
    const store = createSessionStore(() => localStorage);
    store.saveEntitlement("tok");
    store.saveEntitlement(null);
    expect(store.loadEntitlement()).toBeNull();
  });

  it("ignores a corrupted session record", () => {
    localStorage.setItem(SESSION_STORAGE_KEY, "{not json");
    expect(createSessionStore(() => localStorage).loadSession()).toBeNull();
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 5 }));
    expect(createSessionStore(() => localStorage).loadSession()).toBeNull();
  });

  it("falls back to memory for the session only when localStorage throws", () => {
    const store = createSessionStore(() => new ThrowingStorage());
    expect(store.loadSession()).toBeNull();
    store.saveSession(SESSION);
    store.saveEntitlement("tok");
    expect(store.persistent).toBe(false);
    expect(store.loadSession()).toEqual(SESSION);
    expect(store.loadEntitlement()).toBe("tok");
    store.clear();
    expect(store.loadSession()).toBeNull();
  });

  it("falls back to memory when even reading window.localStorage throws", () => {
    const store = createSessionStore(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    store.saveSession(SESSION);
    expect(store.loadSession()).toEqual(SESSION);
    expect(store.persistent).toBe(false);
  });

  it("keeps values written before storage started failing (quota)", () => {
    let fail = false;
    const real = localStorage;
    const flaky: Storage = {
      get length() {
        return real.length;
      },
      clear: () => real.clear(),
      key: (i) => real.key(i),
      getItem: (k) => real.getItem(k),
      removeItem: (k) => real.removeItem(k),
      setItem: (k, v) => {
        if (fail) throw new DOMException("full", "QuotaExceededError");
        real.setItem(k, v);
      },
    };
    const store = createSessionStore(() => flaky);
    store.saveSession(SESSION);
    fail = true;
    store.saveEntitlement("tok");
    expect(store.persistent).toBe(false);
    expect(store.loadSession()).toEqual(SESSION);
    expect(store.loadEntitlement()).toBe("tok");
  });
});
