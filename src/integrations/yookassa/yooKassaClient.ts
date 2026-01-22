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
  amountRubMinor: number;
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
    if (input.amountRubMinor <= 0) throw new YooKassaError("YooKassa amount must be > 0");

    const amountValue = (input.amountRubMinor / 100).toFixed(2);
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

      return {
        id: String(json?.id),
        status: String(json?.status),
        confirmationUrl: json?.confirmation?.confirmation_url ? String(json.confirmation.confirmation_url) : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

