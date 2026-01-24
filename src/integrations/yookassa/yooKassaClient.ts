import { randomUUID } from "node:crypto";

export class YooKassaError extends Error {
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "YooKassaError";
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

export type YooKassaClientOptions = Readonly<{
  shopId: string;
  secretKey: string;
  apiBaseUrl?: string; // default https://api.yookassa.ru
  timeoutMs?: number;
}>;

export type YooKassaCreatePayment = Readonly<{
  amountRub: number;
  description: string;
  returnUrl: string;
  idempotenceKey?: string;
  metadata: Record<string, string>;
}>;

export type YooKassaCreatePaymentResult = Readonly<{
  id: string;
  status: string;
  confirmationUrl?: string;
}>;

export type YooKassaGetPaymentResult = Readonly<{
  id: string;
  status: string;
  paid: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class YooKassaClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(opts: YooKassaClientOptions) {
    this.baseUrl = (opts.apiBaseUrl ?? "https://api.yookassa.ru").replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${opts.shopId}:${opts.secretKey}`).toString("base64")}`;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async createPayment(input: YooKassaCreatePayment): Promise<YooKassaCreatePaymentResult> {
    if (input.amountRub <= 0) throw new YooKassaError("YooKassa amount must be > 0");

    const amountValue = `${Math.trunc(input.amountRub)}.00`;
    const idempotenceKey = input.idempotenceKey ?? randomUUID();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v3/payments`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: this.authHeader,
          "content-type": "application/json",
          "idempotence-key": idempotenceKey,
        },
        body: JSON.stringify({
          amount: { value: amountValue, currency: "RUB" },
          capture: true,
          confirmation: { type: "redirect", return_url: input.returnUrl },
          description: input.description,
          metadata: input.metadata,
        }),
      });

      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new YooKassaError(`YooKassa HTTP ${response.status}`, { status: response.status, details: json });
      }

      if (!isRecord(json)) {
        throw new YooKassaError("YooKassa response invalid JSON shape", { details: json });
      }

      const id = json["id"];
      const status = json["status"];
      if (typeof id !== "string" || typeof status !== "string") {
        throw new YooKassaError("YooKassa response missing id/status", { details: json });
      }

      const confirmation = json["confirmation"];
      const confirmationUrl =
        isRecord(confirmation) && typeof confirmation["confirmation_url"] === "string"
          ? String(confirmation["confirmation_url"])
          : undefined;

      return {
        id,
        status,
        confirmationUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getPayment(paymentId: string): Promise<YooKassaGetPaymentResult> {
    if (!paymentId?.trim().length) throw new YooKassaError("YooKassa paymentId is required");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/v3/payments/${encodeURIComponent(paymentId)}`, {
        method: "GET",
        signal: controller.signal,
        headers: {
          authorization: this.authHeader,
          "content-type": "application/json",
        },
      });

      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new YooKassaError(`YooKassa HTTP ${response.status}`, { status: response.status, details: json });
      }

      if (!isRecord(json)) {
        throw new YooKassaError("YooKassa response invalid JSON shape", { details: json });
      }

      const id = json["id"];
      const status = json["status"];
      const paid = json["paid"];
      if (typeof id !== "string" || typeof status !== "string" || typeof paid !== "boolean") {
        throw new YooKassaError("YooKassa response missing id/status/paid", { details: json });
      }

      return { id, status, paid };
    } finally {
      clearTimeout(timeout);
    }
  }
}
