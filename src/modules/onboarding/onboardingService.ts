import type { PrismaClient, User } from "@prisma/client";
import { addDays } from "../../utils/time";
import { SubscriptionService } from "../subscription/subscriptionService";
import { PaymentStatus } from "../../db/values";

export type StartResult = Readonly<{
  user: User;
  isTrialGrantedNow: boolean;
  subscriptionUrl: string;
  expiresAt?: Date;
  enabled: boolean;
}>;

export class OnboardingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly subscriptions: SubscriptionService,
    private readonly publicPanelBaseUrl: string,
  ) {}

  async handleStart(telegramId: string): Promise<StartResult> {
    const user = await this.prisma.user.upsert({
      where: { telegramId },
      create: { telegramId },
      update: {},
    });

    const state = await this.subscriptions.syncFromXui(user);

    const hasSucceededPayment = await this.prisma.payment.findFirst({
      where: { userId: user.id, status: PaymentStatus.SUCCEEDED },
      select: { id: true },
    });

    const now = new Date();
    const effectiveExpiresAt =
      state.expiresAt && state.subscription.paidUntil
        ? (state.expiresAt.getTime() > state.subscription.paidUntil.getTime() ? state.expiresAt : state.subscription.paidUntil)
        : (state.expiresAt ?? state.subscription.paidUntil ?? undefined);
    const canGrantTrial =
      !user.trialGrantedAt && !hasSucceededPayment && (!effectiveExpiresAt || effectiveExpiresAt.getTime() <= now.getTime());

    let isTrialGrantedNow = false;
    let finalState = state;

    if (canGrantTrial) {
      // Race-safe "only once": claim trial in DB first (conditional), then apply in 3x-ui.
      const claim = await this.prisma.user.updateMany({
        where: { id: user.id, trialGrantedAt: null },
        data: { trialGrantedAt: now },
      });

      if (claim.count === 1) {
        try {
          const expiresAt = addDays(now, 7);
          await this.subscriptions.setExpiryAndEnable({ user, expiresAt, enable: true });
          finalState = await this.subscriptions.syncFromXui(user);
          isTrialGrantedNow = true;
        } catch (e) {
          // Best-effort rollback so the user can retry /start if 3x-ui is temporarily down.
          await this.prisma.user.update({ where: { id: user.id }, data: { trialGrantedAt: null } }).catch(() => {});
          throw e;
        }
      }
    }

    const returnExpiresAt =
      finalState.expiresAt && finalState.subscription.paidUntil
        ? (finalState.expiresAt.getTime() > finalState.subscription.paidUntil.getTime() ? finalState.expiresAt : finalState.subscription.paidUntil)
        : (finalState.expiresAt ?? finalState.subscription.paidUntil ?? undefined);

    return {
      user,
      isTrialGrantedNow,
      subscriptionUrl: this.subscriptions.subscriptionUrl(this.publicPanelBaseUrl, finalState.subscription.xuiSubscriptionId),
      expiresAt: returnExpiresAt,
      enabled: finalState.enabled,
    };
  }
}
