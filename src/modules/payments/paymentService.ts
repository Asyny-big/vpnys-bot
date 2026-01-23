import type { PrismaClient, User } from "@prisma/client";
import { SubscriptionService } from "../subscription/subscriptionService";
import { YooKassaClient } from "../../integrations/yookassa/yooKassaClient";
import { CryptoBotClient } from "../../integrations/cryptobot/cryptoBotClient";
import { randomUUID } from "node:crypto";
import { PaymentProvider, PaymentStatus } from "../../db/values";

export type CreateCheckoutParams = Readonly<{
  telegramId: string;
  provider: PaymentProvider;
  planDays: 30 | 90 | 180;
}>;

export type CreateCheckoutResult = Readonly<{
  payUrl: string;
  providerPaymentId: string;
}>;

export class PaymentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly subscriptions: SubscriptionService,
    private readonly deps: Readonly<{
      yookassa?: YooKassaClient;
      cryptobot?: CryptoBotClient;
      paymentsReturnUrl?: string;
      planRubMinorByDays: Record<30 | 90 | 180, number>;
      cryptobotAsset: string;
      cryptobotAmountByDays: Partial<Record<30 | 90 | 180, string>>;
    }>,
  ) {}

  private async getUserOrThrow(telegramId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new Error("User not found. Require /start first.");
    return user;
  }

  private toJsonString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const user = await this.getUserOrThrow(params.telegramId);
    await this.subscriptions.ensureForUser(user);

    if (params.provider === PaymentProvider.YOOKASSA) {
      if (!this.deps.yookassa) throw new Error("YooKassa is not configured");
      if (!this.deps.paymentsReturnUrl) throw new Error("PAYMENTS_RETURN_URL is required for YooKassa redirects");

      const amountMinor = this.deps.planRubMinorByDays[params.planDays];
      if (!amountMinor) throw new Error(`Price is not configured for plan ${params.planDays}`);

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.YOOKASSA,
          providerPaymentId: `pending_${randomUUID()}`, // overwritten after provider response
          planDays: params.planDays,
          amountMinor,
          currency: "RUB",
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.yookassa.createPayment({
        amountRubMinor: amountMinor,
        description: `VPNYS: подписка ${params.planDays} дней`,
        returnUrl: this.deps.paymentsReturnUrl,
        idempotenceKey: payment.id,
        metadata: { userId: user.id, telegramId: user.telegramId, paymentId: payment.id, planDays: String(params.planDays) },
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: created.id },
      });

      if (!created.confirmationUrl) throw new Error("YooKassa did not return confirmation URL");
      return { payUrl: created.confirmationUrl, providerPaymentId: created.id };
    }

    if (params.provider === PaymentProvider.CRYPTOBOT) {
      if (!this.deps.cryptobot) throw new Error("CryptoBot is not configured");
      const amount = this.deps.cryptobotAmountByDays[params.planDays];
      if (!amount) throw new Error(`CRYPTOBOT_PLAN_${params.planDays}_AMOUNT is not configured`);

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.CRYPTOBOT,
          providerPaymentId: `pending_${randomUUID()}`,
          planDays: params.planDays,
          amountMinor: 0,
          currency: this.deps.cryptobotAsset,
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.cryptobot.createInvoice({
        amount,
        asset: this.deps.cryptobotAsset,
        description: `VPNYS: подписка ${params.planDays} дней`,
        payload: JSON.stringify({ userId: user.id, telegramId: user.telegramId, paymentId: payment.id, planDays: params.planDays }),
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: created.invoiceId },
      });

      return { payUrl: created.payUrl, providerPaymentId: created.invoiceId };
    }

    throw new Error("Unsupported provider");
  }

  async handleYooKassaWebhook(event: any): Promise<void> {
    const paymentId = event?.object?.id;
    const status = event?.object?.status;
    if (!paymentId || typeof paymentId !== "string") return;
    if (status !== "succeeded") return;

    const metadataPaymentId = event?.object?.metadata?.paymentId;

    const payment =
      (await this.prisma.payment.findFirst({
        where: { provider: PaymentProvider.YOOKASSA, providerPaymentId: paymentId },
      })) ??
      (typeof metadataPaymentId === "string"
        ? await this.prisma.payment.findFirst({ where: { id: metadataPaymentId, provider: PaymentProvider.YOOKASSA } })
        : null);
    if (!payment) return;

    const updated = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date(), rawWebhook: this.toJsonString(event) },
    });
    if (updated.count === 0) return;

    const user = await this.prisma.user.findUnique({ where: { id: payment.userId } });
    if (!user) return;
    await this.subscriptions.extend({ user, days: payment.planDays });
  }

  async handleCryptoBotWebhook(event: any): Promise<void> {
    // Crypto Pay webhooks usually look like:
    // { update_type: "invoice_paid", payload: "...", invoice_id: 12345, status: "paid", ... }
    const invoiceId = event?.invoice_id;
    const status = event?.status;
    if (!invoiceId) return;
    if (status !== "paid") return;

    let metadataPaymentId: string | undefined;
    const payload = event?.payload;
    if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload);
        if (typeof parsed?.paymentId === "string") metadataPaymentId = parsed.paymentId;
      } catch {
        // ignore
      }
    }

    const payment =
      (await this.prisma.payment.findFirst({
        where: { provider: PaymentProvider.CRYPTOBOT, providerPaymentId: String(invoiceId) },
      })) ??
      (metadataPaymentId
        ? await this.prisma.payment.findFirst({ where: { id: metadataPaymentId, provider: PaymentProvider.CRYPTOBOT } })
        : null);
    if (!payment) return;

    const updated = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date(), rawWebhook: this.toJsonString(event) },
    });
    if (updated.count === 0) return;

    const user = await this.prisma.user.findUnique({ where: { id: payment.userId } });
    if (!user) return;
    await this.subscriptions.extend({ user, days: payment.planDays });
  }
}
