import type { PrismaClient, User } from "@prisma/client";
import { SubscriptionService } from "../subscription/subscriptionService";
import { YooKassaClient } from "../../integrations/yookassa/yooKassaClient";
import { CryptoBotClient } from "../../integrations/cryptobot/cryptoBotClient";
import { randomUUID } from "node:crypto";
import { PaymentProvider, PaymentStatus, PaymentType } from "../../db/values";
import { addDays } from "../../utils/time";

export type CreateCheckoutParams = Readonly<{
  telegramId: string;
  provider: PaymentProvider;
  planDays: 30 | 90 | 180;
}>;

export type CreateDeviceSlotCheckoutParams = Readonly<{
  telegramId: string;
  provider: PaymentProvider;
}>;

export type CreateCheckoutResult = Readonly<{
  payUrl: string;
  providerPaymentId: string;
}>;

export class PaymentService {
  private static readonly DEVICE_SLOT_RUB_MINOR = 50 * 100;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly subscriptions: SubscriptionService,
    private readonly deps: Readonly<{
      telegramBotToken?: string;
      yookassa?: YooKassaClient;
      cryptobot?: CryptoBotClient;
      paymentsReturnUrl?: string;
      planRubMinorByDays: Record<30 | 90 | 180, number>;
      cryptobotAsset: string;
      cryptobotAmountByDays: Partial<Record<30 | 90 | 180, string>>;
      cryptobotDeviceSlotAmount?: string;
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

  private async notifyTelegram(telegramId: string, text: string): Promise<void> {
    const token = this.deps.telegramBotToken;
    if (!token) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: telegramId, text }),
      });
    } catch {
      // ignore
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
          type: PaymentType.SUBSCRIPTION,
          planDays: params.planDays,
          deviceSlots: 0,
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
          type: PaymentType.SUBSCRIPTION,
          planDays: params.planDays,
          deviceSlots: 0,
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

  async createDeviceSlotCheckout(params: CreateDeviceSlotCheckoutParams): Promise<CreateCheckoutResult> {
    const user = await this.getUserOrThrow(params.telegramId);
    await this.subscriptions.ensureForUser(user);

    if (params.provider === PaymentProvider.YOOKASSA) {
      if (!this.deps.yookassa) throw new Error("YooKassa is not configured");
      if (!this.deps.paymentsReturnUrl) throw new Error("PAYMENTS_RETURN_URL is required for YooKassa redirects");

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.YOOKASSA,
          providerPaymentId: `pending_${randomUUID()}`,
          type: PaymentType.DEVICE_SLOT,
          planDays: 0,
          deviceSlots: 1,
          amountMinor: PaymentService.DEVICE_SLOT_RUB_MINOR,
          currency: "RUB",
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.yookassa.createPayment({
        amountRubMinor: PaymentService.DEVICE_SLOT_RUB_MINOR,
        description: "VPNYS: дополнительное устройство (+1)",
        returnUrl: this.deps.paymentsReturnUrl,
        idempotenceKey: payment.id,
        metadata: { userId: user.id, telegramId: user.telegramId, paymentId: payment.id, type: PaymentType.DEVICE_SLOT, deviceSlots: "1" },
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
      const amount = this.deps.cryptobotDeviceSlotAmount;
      if (!amount) throw new Error("CRYPTOBOT_DEVICE_SLOT_AMOUNT is not configured");

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.CRYPTOBOT,
          providerPaymentId: `pending_${randomUUID()}`,
          type: PaymentType.DEVICE_SLOT,
          planDays: 0,
          deviceSlots: 1,
          amountMinor: 0,
          currency: this.deps.cryptobotAsset,
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.cryptobot.createInvoice({
        amount,
        asset: this.deps.cryptobotAsset,
        description: "VPNYS: дополнительное устройство (+1)",
        payload: JSON.stringify({ userId: user.id, telegramId: user.telegramId, paymentId: payment.id, type: PaymentType.DEVICE_SLOT, deviceSlots: 1 }),
      });

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: created.invoiceId },
      });

      return { payUrl: created.payUrl, providerPaymentId: created.invoiceId };
    }

    throw new Error("Unsupported provider");
  }

  private async applyPaymentEffect(paymentId: string, rawWebhook: unknown): Promise<void> {
    const claim = await this.prisma.payment.updateMany({
      where: { id: paymentId, appliedAt: null, processingAt: null },
      data: { processingAt: new Date() },
    });
    if (claim.count === 0) return;

    try {
      const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return;
      if (payment.appliedAt) return;

      const user = await this.prisma.user.findUnique({ where: { id: payment.userId } });
      if (!user) return;

      if (payment.type === PaymentType.SUBSCRIPTION) {
        let targetExpiresAt = payment.targetExpiresAt ?? undefined;
        if (!targetExpiresAt) {
          const state = await this.subscriptions.syncFromXui(user);
          const now = new Date();
          const base = state.expiresAt && state.expiresAt.getTime() > now.getTime() ? state.expiresAt : now;
          const candidate = addDays(base, payment.planDays);

          await this.prisma.payment.updateMany({
            where: { id: payment.id, targetExpiresAt: null },
            data: { targetExpiresAt: candidate },
          });

          const reread = await this.prisma.payment.findUnique({ where: { id: payment.id } });
          targetExpiresAt = reread?.targetExpiresAt ?? candidate;
        }

        await this.subscriptions.setExpiryAndEnable({ user, expiresAt: targetExpiresAt, enable: true });
        await this.prisma.payment.update({ where: { id: payment.id }, data: { appliedAt: new Date(), processingAt: null, rawWebhook: this.toJsonString(rawWebhook) } });
        await this.notifyTelegram(user.telegramId, `✅ Оплата получена. Подписка продлена до ${targetExpiresAt.toISOString()}`);
        return;
      }

      if (payment.type === PaymentType.DEVICE_SLOT) {
        let targetDeviceLimit = payment.targetDeviceLimit ?? undefined;

        if (!targetDeviceLimit) {
          const computed = await this.prisma.$transaction(async (tx) => {
            const subscription = await tx.subscription.findUnique({ where: { userId: payment.userId } });
            if (!subscription) throw new Error("Subscription not found");
            const updated = await tx.subscription.update({
              where: { id: subscription.id },
              data: { deviceLimit: { increment: Math.max(1, payment.deviceSlots || 1) } },
            });
            await tx.payment.update({
              where: { id: payment.id },
              data: { targetDeviceLimit: updated.deviceLimit },
            });
            return updated.deviceLimit;
          });
          targetDeviceLimit = computed;
        }

        const ensured = await this.subscriptions.ensureDeviceLimit(payment.userId, targetDeviceLimit);
        await this.prisma.payment.update({ where: { id: payment.id }, data: { appliedAt: new Date(), processingAt: null, rawWebhook: this.toJsonString(rawWebhook) } });
        await this.notifyTelegram(user.telegramId, `✅ Устройство добавлено. Лимит устройств: ${ensured.deviceLimit}`);
        return;
      }
    } finally {
      await this.prisma.payment.updateMany({ where: { id: paymentId, appliedAt: null }, data: { processingAt: null } });
    }
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

    const rawWebhook = this.toJsonString(event);
    await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date(), rawWebhook },
    });

    await this.applyPaymentEffect(payment.id, rawWebhook);
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

    const rawWebhook = this.toJsonString(event);
    await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date(), rawWebhook },
    });

    await this.applyPaymentEffect(payment.id, rawWebhook);
  }
}
