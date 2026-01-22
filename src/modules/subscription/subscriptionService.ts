import type { PrismaClient, Subscription, User } from "@prisma/client";
import { SubscriptionStatus } from "@prisma/client";
import { ThreeXUiService } from "../../integrations/threeXui/threeXuiService";
import { addDays } from "../../utils/time";

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
      flow: this.xuiClientFlow,
    });

    return await this.prisma.subscription.create({
      data: {
        userId: user.id,
        xuiInboundId: this.xuiInboundId,
        xuiClientUuid: client.uuid,
        xuiSubscriptionId: client.subscriptionId,
        enabled: client.enabled,
        expiresAt: client.expiresAt,
        lastSyncedAt: new Date(),
        status: client.expiresAt && client.expiresAt.getTime() <= Date.now() ? SubscriptionStatus.EXPIRED : SubscriptionStatus.ACTIVE,
      },
    });
  }

  async syncFromXui(user: User): Promise<SubscriptionState> {
    const subscription = await this.ensureForUser(user);

    const client = await this.xui.findClientByUuid(subscription.xuiInboundId, subscription.xuiClientUuid);
    if (!client) {
      // Repair: DB lost sync with panel. Re-create/find by email.
      const repaired = await this.xui.ensureClient({ inboundId: subscription.xuiInboundId, telegramId: user.telegramId });
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

    const expiresAt = client.expiresAt;
    const enabled = client.enabled;
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

    await this.xui.setExpiryAndEnable({
      inboundId: subscription.xuiInboundId,
      uuid: subscription.xuiClientUuid,
      subscriptionId: subscription.xuiSubscriptionId,
      expiresAt: params.expiresAt,
      enabled: params.enable,
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

  async extend(params: { user: User; days: number }): Promise<Subscription> {
    const state = await this.syncFromXui(params.user);
    const now = new Date();
    const base = state.expiresAt && state.expiresAt.getTime() > now.getTime() ? state.expiresAt : now;
    const nextExpiresAt = addDays(base, params.days);
    return await this.setExpiryAndEnable({ user: params.user, expiresAt: nextExpiresAt, enable: true });
  }

  subscriptionUrl(publicPanelBaseUrl: string, subscriptionId: string): string {
    return this.xui.subscriptionUrl(publicPanelBaseUrl, subscriptionId);
  }
}
