import { setTimeout as delay } from "node:timers/promises";

export class ThreeXUiError extends Error {
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "ThreeXUiError";
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

type XuiEnvelope<T> =
  | { success: true; obj?: T; data?: T }
  | { success: false; msg?: string; obj?: unknown; data?: unknown };

export type ThreeXUiApiClientOptions = Readonly<{
  baseUrl: string; // localhost-only
  username: string;
  password: string;
  timeoutMs?: number;
  maxRetries?: number;
}>;

export class ThreeXUiApiClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  private cookieHeader?: string;
  private cookieSetAt?: number;

  constructor(opts: ThreeXUiApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.username = opts.username;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 1;
  }

  async login(): Promise<void> {
    // 3x-ui typically uses form POST /login and returns a Set-Cookie with the session.
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    });

    const response = await this.rawFetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      throw new ThreeXUiError(`3x-ui login failed: HTTP ${response.status}`, {
        status: response.status,
      });
    }

    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) {
      throw new ThreeXUiError("3x-ui login did not return set-cookie");
    }

    // Keep only the first cookie pair for Cookie header.
    this.cookieHeader = setCookie.split(";")[0] ?? setCookie;
    this.cookieSetAt = Date.now();
  }

  private shouldRelogin(): boolean {
    if (!this.cookieHeader || !this.cookieSetAt) return true;
    // Defensive: 3x-ui session lifetime varies; refresh periodically.
    return Date.now() - this.cookieSetAt > 50 * 60 * 1000;
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.shouldRelogin()) await this.login();

      const response = await this.rawFetch(path, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.headers ?? {}),
          ...(this.cookieHeader ? { cookie: this.cookieHeader } : {}),
        },
      });

      if (response.status === 401 || response.status === 403) {
        this.cookieHeader = undefined;
        if (attempt < this.maxRetries) {
          await delay(150);
          continue;
        }
      }

      const text = await response.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new ThreeXUiError(`3x-ui invalid JSON: HTTP ${response.status}`, {
          status: response.status,
          details: text,
        });
      }

      if (!response.ok) {
        throw new ThreeXUiError(`3x-ui HTTP ${response.status}`, { status: response.status, details: json });
      }

      const envelope = json as XuiEnvelope<T>;
      if (typeof envelope?.success === "boolean") {
        if (!envelope.success) {
          throw new ThreeXUiError(`3x-ui error: ${(envelope as any).msg ?? "unknown"}`, { details: json });
        }
        const payload = (envelope as any).obj ?? (envelope as any).data;
        return payload as T;
      }

      return json as T;
    }

    throw new ThreeXUiError("3x-ui request retry exhausted");
  }
}

