export class CryptoBotError extends Error {
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "CryptoBotError";
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

export type CryptoBotClientOptions = Readonly<{
  apiToken: string;
  apiBaseUrl?: string; // default https://pay.crypt.bot/api
  timeoutMs?: number;
}>;

export type CryptoBotCreateInvoice = Readonly<{
  amount: string;
  asset: string;
  description: string;
  payload: string;
}>;

export type CryptoBotCreateInvoiceResult = Readonly<{
  invoiceId: string;
  payUrl: string;
}>;

export class CryptoBotClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;

  constructor(opts: CryptoBotClientOptions) {
    this.baseUrl = (opts.apiBaseUrl ?? "https://pay.crypt.bot/api").replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async createInvoice(input: CryptoBotCreateInvoice): Promise<CryptoBotCreateInvoiceResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/createInvoice`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "crypto-pay-api-token": this.apiToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount: input.amount,
          asset: input.asset,
          description: input.description,
          payload: input.payload,
        }),
      });

      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new CryptoBotError(`CryptoBot HTTP ${response.status}`, { status: response.status, details: json });
      }

      if (!json?.ok) {
        throw new CryptoBotError("CryptoBot response not ok", { details: json });
      }

      const result = json.result;
      return {
        invoiceId: String(result.invoice_id),
        payUrl: String(result.pay_url),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

