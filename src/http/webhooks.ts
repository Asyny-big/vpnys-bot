import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { PaymentService } from "../modules/payments/paymentService";

function isYooKassaWebhook(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const event = (body as any).event;
  const object = (body as any).object;
  return typeof event === "string" && event.startsWith("payment.") && object && typeof object === "object";
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function requireWebhookToken(req: FastifyRequest, expected: string): void {
  const token = String(req.headers["x-webhook-token"] ?? "");
  if (!token || !safeEqual(token, expected)) {
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

export async function registerWebhooks(app: FastifyInstance, deps: { webhookToken: string; payments: PaymentService }): Promise<void> {
  const handleYooKassa = async (req: FastifyRequest, reply: any) => {
    await deps.payments.handleYooKassaWebhook(req.body as any);
    return await reply.code(200).send({ ok: true });
  };

  // YooKassa doesn't provide a webhook secret in the cabinet, so this endpoint must not require X-WEBHOOK-TOKEN.
  app.post("/webhooks/yookassa", handleYooKassa);
  // Optional alias to match common reverse-proxy setups.
  app.post("/api/yookassa/webhook", handleYooKassa);

  app.post("/webhooks/cryptobot", async (req, reply) => {
    // If a reverse proxy accidentally routes YooKassa notifications here, don't block them with token auth.
    // (YooKassa has no shared secret for webhooks; idempotency is handled in PaymentService.)
    if (isYooKassaWebhook(req.body)) {
      await deps.payments.handleYooKassaWebhook(req.body as any);
      return await reply.code(200).send({ ok: true });
    }

    requireWebhookToken(req, deps.webhookToken);
    await deps.payments.handleCryptoBotWebhook(req.body as any);
    return await reply.code(200).send({ ok: true });
  });
}
