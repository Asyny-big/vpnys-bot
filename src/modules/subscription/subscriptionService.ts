import type { PrismaClient, Subscription, User } from "@prisma/client";
import { ThreeXUiService } from "../../integrations/threeXui/threeXuiService";
import { addDays } from "../../utils/time";
import { SubscriptionStatus } from "../../db/values";
import { MAX_DEVICE_LIMIT, MIN_DEVICE_LIMIT, clampDeviceLimit } from "../../domain/deviceLimits";

export type SubscriptionState = Readonly<{
  subscription: Subscription;
  expiresAt?: Date;
  enabled: boolean;
}>;

export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly xui: ThreeXUiService,
    private readonly xuiInboundId: number,
    private readonly xuiClientFlow?: string,
  ) {}

  async ensureForUser(user: User): Promise<Subscription> {
    const existing = await this.prisma.subscription.findUnique({ where: { userId: user.id } });
    if (existing) return existing;

    const client = await this.xui.ensureClient({
      inboundId: this.xuiInboundId,
      telegramId: user.telegramId,
      deviceLimit: MIN_DEVICE_LIMIT,
      flow: this.xuiClientFlow,
    });

    try {
      return await this.prisma.subscription.create({
        data: {
          userId: user.id,
          xuiInboundId: this.xuiInboundId,
          xuiClientUuid: client.uuid,
          xuiSubscriptionId: client.subscriptionId,
          deviceLimit: MIN_DEVICE_LIMIT,
          enabled: client.enabled,
          expiresAt: client.expiresAt,
          lastSyncedAt: new Date(),
          status: client.expiresAt && client.expiresAt.getTime() <= Date.now() ? SubscriptionStatus.EXPIRED : SubscriptionStatus.ACTIVE,
        },
      });
    } catch (e: any) {
      // Race-safe: concurrent /start may attempt to create the same row; unique constraints will reject one.
      if (e?.code === "P2002") {
        const reread = await this.prisma.subscription.findUnique({ where: { userId: user.id } });
        if (reread) return reread;
      }
      throw e;
    }
  }

  async syncFromXui(user: User): Promise<SubscriptionState> {
    let subscription = await this.ensureForUser(user);
    const normalizedDeviceLimit = clampDeviceLimit(subscription.deviceLimit);
    if (normalizedDeviceLimit !== subscription.deviceLimit) {
      subscription = await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { deviceLimit: normalizedDeviceLimit },
      });
    }

    const client = await this.xui.findClientByUuid(subscription.xuiInboundId, subscription.xuiClientUuid);
    if (!client) {
      // Repair: DB lost sync with panel. Re-create/find by email.
      const repaired = await this.xui.ensureClient({ inboundId: subscription.xuiInboundId, telegramId: user.telegramId, deviceLimit: subscription.deviceLimit });
      const updated = await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          xuiClientUuid: repaired.uuid,
          xuiSubscriptionId: repaired.subscriptionId,
          enabled: repaired.enabled,
          expiresAt: repaired.expiresAt,
          lastSyncedAt: new Date(),
        },
      });
      return { subscription: updated, expiresAt: repaired.expiresAt, enabled: repaired.enabled };
    }

    let expiresAt = client.expiresAt;
    let enabled = client.enabled;

    const now = new Date();
    const paidUntil = subscription.paidUntil;
    if (paidUntil && paidUntil.getTime() > now.getTime()) {
      const needsExtend = !expiresAt || expiresAt.getTime() < paidUntil.getTime();
      if (needsExtend) {
        await this.xui.setExpiryAndEnable({
          inboundId: subscription.xuiInboundId,
          uuid: subscription.xuiClientUuid,
          subscriptionId: subscription.xuiSubscriptionId,
          expiresAt: paidUntil,
          enabled: true,
          deviceLimit: subscription.deviceLimit,
        });
        expiresAt = paidUntil;
        enabled = true;
      }
    }

    if (typeof client.limitIp === "number" && client.limitIp !== subscription.deviceLimit) {
      await this.xui.updateClient(subscription.xuiInboundId, subscription.xuiClientUuid, { deviceLimit: subscription.deviceLimit });
    }
    const status =
      expiresAt && expiresAt.getTime() <= Date.now()
        ? SubscriptionStatus.EXPIRED
        : enabled
          ? SubscriptionStatus.ACTIVE
          : SubscriptionStatus.DISABLED;

    const updated = await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        enabled,
        expiresAt: expiresAt ?? null,
        status,
        lastSyncedAt: new Date(),
      },
    });

    return { subscription: updated, expiresAt, enabled };
  }

  async setExpiryAndEnable(params: {
    user: User;
    expiresAt: Date;
    enable: boolean;
  }): Promise<Subscription> {
    const subscription = await this.ensureForUser(params.user);
    const deviceLimit = clampDeviceLimit(subscription.deviceLimit);
    if (deviceLimit !== subscription.deviceLimit) {
      await this.prisma.subscription.update({ where: { id: subscription.id }, data: { deviceLimit } });
    }

    await this.xui.setExpiryAndEnable({
      inboundId: subscription.xuiInboundId,
      uuid: subscription.xuiClientUuid,
      subscriptionId: subscription.xuiSubscriptionId,
      expiresAt: params.expiresAt,
      enabled: params.enable,
      deviceLimit,
    });

    return await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        expiresAt: params.expiresAt,
        enabled: params.enable,
        status: params.expiresAt.getTime() <= Date.now() ? SubscriptionStatus.EXPIRED : SubscriptionStatus.ACTIVE,
        lastSyncedAt: new Date(),
      },
    });
  }

  async addDeviceSlot(userId: string): Promise<Subscription> {
    const claimed = await this.prisma.subscription.updateMany({
      where: { userId, deviceLimit: { lt: MAX_DEVICE_LIMIT } },
      data: { deviceLimit: { increment: 1 } },
    });
    if (claimed.count === 0) throw new Error("Device limit reached");

    const updated = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!updated) throw new Error("Subscription not found");

    const deviceLimit = clampDeviceLimit(updated.deviceLimit);
    if (deviceLimit !== updated.deviceLimit) {
      await this.prisma.subscription.update({ where: { id: updated.id }, data: { deviceLimit } });
    }

    await this.xui.updateClient(updated.xuiInboundId, updated.xuiClientUuid, { deviceLimit });

    return await this.prisma.subscription.update({
      where: { id: updated.id },
      data: { lastSyncedAt: new Date() },
    });
  }

  async ensureDeviceLimit(userId: string, targetDeviceLimit: number): Promise<Subscription> {
    const subscription = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!subscription) throw new Error("Subscription not found");

    const target = clampDeviceLimit(targetDeviceLimit);
    const current = clampDeviceLimit(subscription.deviceLimit);
    if (current !== subscription.deviceLimit) {
      await this.prisma.subscription.update({ where: { id: subscription.id }, data: { deviceLimit: current } });
    }

    const next = current >= target
      ? { ...subscription, deviceLimit: current }
      : await this.prisma.subscription.update({ where: { id: subscription.id }, data: { deviceLimit: target } });

    await this.xui.updateClient(next.xuiInboundId, next.xuiClientUuid, { deviceLimit: next.deviceLimit });

    return await this.prisma.subscription.update({
      where: { id: next.id },
      data: { lastSyncedAt: new Date() },
    });
  }

  async extend(params: { user: User; days: number }): Promise<Subscription> {
    const state = await this.syncFromXui(params.user);
    const now = new Date();
    const current = state.expiresAt && state.expiresAt.getTime() > now.getTime() ? state.expiresAt : now;
    const paidUntil = state.subscription.paidUntil && state.subscription.paidUntil.getTime() > now.getTime() ? state.subscription.paidUntil : now;
    const base = paidUntil.getTime() > current.getTime() ? paidUntil : current;
    const nextExpiresAt = addDays(base, params.days);
    return await this.setExpiryAndEnable({ user: params.user, expiresAt: nextExpiresAt, enable: true });
  }

  subscriptionUrl(backendPublicUrl: string, token: string): string {
    const base = backendPublicUrl.replace(/\/+$/, "");
    return `${base}/sub/${encodeURIComponent(token.trim())}`;
  }

  connectUrl(backendPublicUrl: string, token: string): string {
    const base = backendPublicUrl.replace(/\/+$/, "");
    return `${base}/connect/${encodeURIComponent(token.trim())}`;
  }
}
