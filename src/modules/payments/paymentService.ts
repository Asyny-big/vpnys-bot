import type { PrismaClient, User } from "@prisma/client";
import { SubscriptionService } from "../subscription/subscriptionService";
import { YooKassaClient } from "../../integrations/yookassa/yooKassaClient";
import { CryptoBotClient } from "../../integrations/cryptobot/cryptoBotClient";
import { randomUUID } from "node:crypto";
import { PaymentProvider, PaymentStatus, PaymentType } from "../../db/values";
import { addDays } from "../../utils/time";
import { MAX_DEVICE_LIMIT, clampDeviceLimit } from "../../domain/deviceLimits";
import { EXTRA_DEVICE_RUB } from "../../domain/pricing";
import { formatRuDateTime } from "../../domain/humanDate";
import { formatRuDevices } from "../../domain/humanDevices";

export type CreateCheckoutParams = Readonly<{
  telegramId: string;
  provider: PaymentProvider;
  planDays: 30 | 90 | 180;
}>;

export type CreateDeviceSlotCheckoutParams = Readonly<{
  telegramId: string;
  provider: PaymentProvider;
}>;

export type CreateSubscriptionCheckoutParams = Readonly<{
  telegramId: string;
  provider: PaymentProvider;
  planDays: 30 | 90 | 180;
  deviceLimit: number;
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
      telegramBotToken?: string;
      yookassa?: YooKassaClient;
      cryptobot?: CryptoBotClient;
      paymentsReturnUrl?: string;
      planRubByDays: Record<30 | 90 | 180, number>;
      cryptobotAsset: string;
      rubToUsdtRate?: number; // RUB per 1 USDT (e.g. 100 means 100 ₽ ≈ 1 USDT)
      cryptobotPlanRubByDays?: Partial<Record<30 | 90 | 180, number>>; // optional override vs planRubByDays
      cryptobotDeviceSlotRub?: number; // optional override vs EXTRA_DEVICE_RUB
    }>,
  ) {}

  async quoteSubscription(params: { telegramId: string; planDays: 30 | 90 | 180; deviceLimit: number }): Promise<{
    currentDeviceLimit: number;
    selectedDeviceLimit: number;
    maxDeviceLimit: number;
    baseRub: number;
    extraDeviceRub: number;
    totalRub: number;
  }> {
    const user = await this.getUserOrThrow(params.telegramId);
    const subscription = await this.subscriptions.ensureForUser(user);

    const baseRub = this.getPlanRubOrThrow(params.planDays);

    const currentDeviceLimit = clampDeviceLimit(subscription.deviceLimit);
    const selectedDeviceLimit = clampDeviceLimit(Math.max(currentDeviceLimit, params.deviceLimit));
    const totalRub = baseRub + (selectedDeviceLimit - 1) * EXTRA_DEVICE_RUB;

    return {
      currentDeviceLimit,
      selectedDeviceLimit,
      maxDeviceLimit: MAX_DEVICE_LIMIT,
      baseRub,
      extraDeviceRub: EXTRA_DEVICE_RUB,
      totalRub,
    };
  }

  async quoteDeviceSlot(params: { telegramId: string }): Promise<{
    currentDeviceLimit: number;
    maxDeviceLimit: number;
    canAdd: boolean;
    priceRub: number;
  }> {
    const user = await this.getUserOrThrow(params.telegramId);
    const subscription = await this.subscriptions.ensureForUser(user);
    const currentDeviceLimit = clampDeviceLimit(subscription.deviceLimit);
    return {
      currentDeviceLimit,
      maxDeviceLimit: MAX_DEVICE_LIMIT,
      canAdd: currentDeviceLimit < MAX_DEVICE_LIMIT,
      priceRub: EXTRA_DEVICE_RUB,
    };
  }

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

  private computeUsdtAmountFromRub(rubAmount: number): string {
    const rate = this.deps.rubToUsdtRate;
    if (!Number.isFinite(rate) || !rate || rate <= 0) {
      throw new Error("RUB_TO_USDT_RATE is not configured");
    }

    const rub = Number.isFinite(rubAmount) ? Math.trunc(rubAmount) : 0;
    if (rub <= 0) throw new Error(`RUB amount must be > 0 (got: ${String(rubAmount)})`);

    const raw = rub / rate;
    if (!Number.isFinite(raw) || raw <= 0) throw new Error("Computed USDT amount must be > 0");

    return raw.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  isYooKassaEnabled(): boolean {
    return !!this.deps.yookassa;
  }

  isCryptoBotEnabled(): boolean {
    return !!this.deps.cryptobot;
  }

  private getPlanRubOrThrow(planDays: 30 | 90 | 180): number {
    const value = this.deps.planRubByDays[planDays];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`PLAN_${planDays}_RUB is not configured (got: ${String(value)})`);
    }
    return Math.trunc(value);
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CreateCheckoutResult> {
    const user = await this.getUserOrThrow(params.telegramId);
    await this.subscriptions.ensureForUser(user);

    if (params.provider === PaymentProvider.YOOKASSA) {
      if (!this.deps.yookassa) throw new Error("YooKassa is not configured");
      if (!this.deps.paymentsReturnUrl) throw new Error("PAYMENTS_RETURN_URL is required for YooKassa redirects");

      const amountRub = this.getPlanRubOrThrow(params.planDays);

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.YOOKASSA,
          providerPaymentId: `pending_${randomUUID()}`, // overwritten after provider response
          type: PaymentType.SUBSCRIPTION,
          planDays: params.planDays,
          deviceSlots: 0,
          amountRub,
          currency: "RUB",
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.yookassa.createPayment({
        amountRub,
        description: `ЛисVPN — подписка на ${params.planDays} дней`,
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

      const planRubRaw = this.deps.cryptobotPlanRubByDays?.[params.planDays] ?? this.getPlanRubOrThrow(params.planDays);
      if (!Number.isFinite(planRubRaw) || planRubRaw <= 0) throw new Error(`CRYPTOBOT_PLAN_${params.planDays}_RUB is not configured`);
      const planRub = Math.trunc(planRubRaw);
      const amount = this.computeUsdtAmountFromRub(planRub);

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.CRYPTOBOT,
          providerPaymentId: `pending_${randomUUID()}`,
          type: PaymentType.SUBSCRIPTION,
          planDays: params.planDays,
          deviceSlots: 0,
          amountRub: planRub,
          currency: this.deps.cryptobotAsset,
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.cryptobot.createInvoice({
        amount,
        asset: this.deps.cryptobotAsset,
        description: `ЛисVPN — подписка на ${params.planDays} дней`,
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

  async createSubscriptionCheckout(params: CreateSubscriptionCheckoutParams): Promise<CreateCheckoutResult> {
    const user = await this.getUserOrThrow(params.telegramId);
    const subscription = await this.subscriptions.ensureForUser(user);

    const quoted = await this.quoteSubscription({
      telegramId: params.telegramId,
      planDays: params.planDays,
      deviceLimit: params.deviceLimit,
    });

    const targetDeviceLimit = quoted.selectedDeviceLimit;
    const deviceSlots = Math.max(0, targetDeviceLimit - clampDeviceLimit(subscription.deviceLimit));

    if (params.provider === PaymentProvider.YOOKASSA) {
      if (!this.deps.yookassa) throw new Error("YooKassa is not configured");
      if (!this.deps.paymentsReturnUrl) throw new Error("PAYMENTS_RETURN_URL is required for YooKassa redirects");

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.YOOKASSA,
          providerPaymentId: `pending_${randomUUID()}`,
          type: PaymentType.SUBSCRIPTION,
          planDays: params.planDays,
          deviceSlots,
          amountRub: quoted.totalRub,
          currency: "RUB",
          status: PaymentStatus.PENDING,
          targetDeviceLimit,
        },
      });

      const created = await this.deps.yookassa.createPayment({
        amountRub: quoted.totalRub,
        description: `ЛисVPN — подписка на ${params.planDays} дней, ${formatRuDevices(targetDeviceLimit)}`,
        returnUrl: this.deps.paymentsReturnUrl,
        idempotenceKey: payment.id,
        metadata: {
          userId: user.id,
          telegramId: user.telegramId,
          paymentId: payment.id,
          planDays: String(params.planDays),
          deviceLimit: String(targetDeviceLimit),
        },
      });

      await this.prisma.payment.update({ where: { id: payment.id }, data: { providerPaymentId: created.id } });
      if (!created.confirmationUrl) throw new Error("YooKassa did not return confirmation URL");
      return { payUrl: created.confirmationUrl, providerPaymentId: created.id };
    }

    if (params.provider === PaymentProvider.CRYPTOBOT) {
      if (!this.deps.cryptobot) throw new Error("CryptoBot is not configured");

      const totalRub = quoted.totalRub;
      const amount = this.computeUsdtAmountFromRub(totalRub);

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.CRYPTOBOT,
          providerPaymentId: `pending_${randomUUID()}`,
          type: PaymentType.SUBSCRIPTION,
          planDays: params.planDays,
          deviceSlots,
          amountRub: totalRub,
          currency: this.deps.cryptobotAsset,
          status: PaymentStatus.PENDING,
          targetDeviceLimit,
        },
      });

      const created = await this.deps.cryptobot.createInvoice({
        amount,
        asset: this.deps.cryptobotAsset,
        description: `ЛисVPN — подписка на ${params.planDays} дней, ${formatRuDevices(targetDeviceLimit)}`,
        payload: JSON.stringify({
          userId: user.id,
          telegramId: user.telegramId,
          paymentId: payment.id,
          planDays: params.planDays,
          deviceLimit: targetDeviceLimit,
        }),
      });

      await this.prisma.payment.update({ where: { id: payment.id }, data: { providerPaymentId: created.invoiceId } });
      return { payUrl: created.payUrl, providerPaymentId: created.invoiceId };
    }

    throw new Error("Unsupported provider");
  }

  async createDeviceSlotCheckout(params: CreateDeviceSlotCheckoutParams): Promise<CreateCheckoutResult> {
    const user = await this.getUserOrThrow(params.telegramId);
    const sub = await this.subscriptions.ensureForUser(user);
    if (clampDeviceLimit(sub.deviceLimit) >= MAX_DEVICE_LIMIT) {
      throw new Error("Device limit reached");
    }

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
          amountRub: EXTRA_DEVICE_RUB,
          currency: "RUB",
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.yookassa.createPayment({
        amountRub: EXTRA_DEVICE_RUB,
        description: "ЛисVPN — ещё одно устройство",
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

      const deviceSlotRubRaw = this.deps.cryptobotDeviceSlotRub ?? EXTRA_DEVICE_RUB;
      if (!Number.isFinite(deviceSlotRubRaw) || deviceSlotRubRaw <= 0) throw new Error("CRYPTOBOT_DEVICE_SLOT_RUB is not configured");
      const deviceSlotRub = Math.trunc(deviceSlotRubRaw);
      const amount = this.computeUsdtAmountFromRub(deviceSlotRub);

      const payment = await this.prisma.payment.create({
        data: {
          userId: user.id,
          provider: PaymentProvider.CRYPTOBOT,
          providerPaymentId: `pending_${randomUUID()}`,
          type: PaymentType.DEVICE_SLOT,
          planDays: 0,
          deviceSlots: 1,
          amountRub: deviceSlotRub,
          currency: this.deps.cryptobotAsset,
          status: PaymentStatus.PENDING,
        },
      });

      const created = await this.deps.cryptobot.createInvoice({
        amount,
        asset: this.deps.cryptobotAsset,
        description: "ЛисVPN — ещё одно устройство",
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
          const current = state.expiresAt && state.expiresAt.getTime() > now.getTime() ? state.expiresAt : now;
          const paidUntil = state.subscription.paidUntil && state.subscription.paidUntil.getTime() > now.getTime() ? state.subscription.paidUntil : now;
          const base = paidUntil.getTime() > current.getTime() ? paidUntil : current;
          const candidate = addDays(base, payment.planDays);

          await this.prisma.payment.updateMany({
            where: { id: payment.id, targetExpiresAt: null },
            data: { targetExpiresAt: candidate },
          });

          const reread = await this.prisma.payment.findUnique({ where: { id: payment.id } });
          targetExpiresAt = reread?.targetExpiresAt ?? candidate;
        }

        await this.subscriptions.setExpiryAndEnable({ user, expiresAt: targetExpiresAt, enable: true });
        await this.prisma.subscription.updateMany({
          where: { userId: user.id },
          data: { paidUntil: targetExpiresAt },
        });
        if (typeof payment.targetDeviceLimit === "number") {
          await this.subscriptions.ensureDeviceLimit(payment.userId, payment.targetDeviceLimit);
        }
        await this.prisma.payment.update({ where: { id: payment.id }, data: { appliedAt: new Date(), processingAt: null, rawWebhook: this.toJsonString(rawWebhook) } });
        await this.notifyTelegram(user.telegramId, `✅ Оплата прошла! VPN работает до ${formatRuDateTime(targetExpiresAt)}`);
        return;
      }

      if (payment.type === PaymentType.DEVICE_SLOT) {
        let targetDeviceLimit = payment.targetDeviceLimit ?? undefined;

        if (!targetDeviceLimit) {
          const computed = await this.prisma.$transaction(async (tx) => {
            const subscription = await tx.subscription.findUnique({ where: { userId: payment.userId } });
            if (!subscription) throw new Error("Subscription not found");
            const current = clampDeviceLimit(subscription.deviceLimit);
            const slots = Math.max(1, Math.floor(payment.deviceSlots || 1));
            const target = clampDeviceLimit(Math.min(MAX_DEVICE_LIMIT, current + slots));
            const updated = current === target
              ? subscription
              : await tx.subscription.update({
                where: { id: subscription.id },
                data: { deviceLimit: target },
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
        await this.notifyTelegram(user.telegramId, `✅ Готово! Теперь можно подключить ${formatRuDevices(ensured.deviceLimit)}.`);
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
