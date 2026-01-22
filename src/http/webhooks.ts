import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { PaymentService } from "../modules/payments/paymentService";

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
  app.post("/webhooks/yookassa", async (req, reply) => {
    requireWebhookToken(req, deps.webhookToken);
    await deps.payments.handleYooKassaWebhook(req.body as any);
    return await reply.code(200).send({ ok: true });
  });

  app.post("/webhooks/cryptobot", async (req, reply) => {
    requireWebhookToken(req, deps.webhookToken);
    await deps.payments.handleCryptoBotWebhook(req.body as any);
    return await reply.code(200).send({ ok: true });
  });
}

