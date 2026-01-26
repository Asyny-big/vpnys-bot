import type { PrismaClient, User } from "@prisma/client";
import { addDays } from "../../utils/time";
import { SubscriptionService } from "../subscription/subscriptionService";
import { PaymentStatus } from "../../db/values";
import { isOfferAccepted } from "../../domain/offer";
import { ReferralService } from "../referral/referralService";

export type StartResult = Readonly<{
  user: User;
  isOfferAccepted: boolean;
  isTrialGrantedNow: boolean;
  referralReward?: Readonly<{ inviterTelegramId: string }>;
  subscriptionUrl: string;
  expiresAt?: Date;
  enabled: boolean;
}>;

function parseInviterTelegramId(startParam: string | undefined): string | null {
  const raw = typeof startParam === "string" ? startParam.trim() : "";
  if (!raw.startsWith("ref_")) return null;
  const inviterTelegramId = raw.slice("ref_".length).trim();
  if (!/^\d{1,20}$/.test(inviterTelegramId)) return null;
  return inviterTelegramId;
}

export class OnboardingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly subscriptions: SubscriptionService,
    private readonly referrals: ReferralService,
    private readonly backendPublicUrl: string,
    private readonly deps: Readonly<{ offerVersion: string }>,
  ) {}

  async handleStart(params: { telegramId: string; startParam?: string; offerAcceptedAt?: Date | null }): Promise<StartResult> {
    const telegramId = params.telegramId;
    const offerAcceptedAt = params.offerAcceptedAt ?? undefined;

    // IMPORTANT: referral logic must run only on first-ever registration.
    // Therefore we must NOT pre-create the user row before checking /start ref_* parameter.
    let createdNow = false;

    let user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      const inviterTelegramId = parseInviterTelegramId(params.startParam);

      // Anti-abuse: prevent self-referral and ignore invalid inviter ids.
      const inviter =
        inviterTelegramId && inviterTelegramId !== telegramId
          ? await this.prisma.user.findUnique({ where: { telegramId: inviterTelegramId } })
          : null;

      try {
        user = await this.prisma.user.create({
          data: {
            telegramId,
            referralCode: telegramId,
            referredById: inviter?.id ?? null,
            ...(offerAcceptedAt ? { offerAcceptedAt, offerVersion: this.deps.offerVersion } : {}),
          },
        });
        createdNow = true;
      } catch (e: any) {
        // Race-safe: concurrent /start may attempt to create the same row; unique constraints will reject one.
        if (e?.code !== "P2002") throw e;
        user = await this.prisma.user.findUnique({ where: { telegramId } });
        if (!user) throw e;
      }
    } else if (offerAcceptedAt && !user.offerAcceptedAt) {
      // Persist offer acceptance for existing users (new users store it at create time above).
      await this.prisma.user.updateMany({
        where: { id: user.id, offerAcceptedAt: null },
        data: { offerAcceptedAt, offerVersion: this.deps.offerVersion },
      });
      user = { ...user, offerAcceptedAt, offerVersion: this.deps.offerVersion };
    }

    const state = await this.subscriptions.syncFromXui(user);
    const offerOk = isOfferAccepted(user as any, this.deps.offerVersion);

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
      offerOk && !user.trialGrantedAt && !hasSucceededPayment && (!effectiveExpiresAt || effectiveExpiresAt.getTime() <= now.getTime());

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

    let referralReward: StartResult["referralReward"] | undefined;
    if (createdNow) {
      const granted = await this.referrals.grantRegistrationRewardIfEligible({ invitedUserId: user.id });
      if (granted.status === "applied") {
        referralReward = { inviterTelegramId: granted.inviterTelegramId };
      }

      // Ensure the returned subscription snapshot includes any paidUntil changes done by referral reward.
      // Best-effort: prefer the DB value, even if 3x-ui sync is temporarily unavailable.
      const refreshed = await this.prisma.subscription.findUnique({ where: { userId: user.id } });
      if (refreshed) finalState = { ...finalState, subscription: refreshed };
    }

    const returnExpiresAt =
      finalState.expiresAt && finalState.subscription.paidUntil
        ? (finalState.expiresAt.getTime() > finalState.subscription.paidUntil.getTime() ? finalState.expiresAt : finalState.subscription.paidUntil)
        : (finalState.expiresAt ?? finalState.subscription.paidUntil ?? undefined);

    const token = finalState.subscription.xuiSubscriptionId;
    return {
      user,
      isOfferAccepted: offerOk,
      isTrialGrantedNow,
      referralReward,
      subscriptionUrl: this.subscriptions.connectUrl(this.backendPublicUrl, token),
      expiresAt: returnExpiresAt,
      enabled: finalState.enabled,
    };
  }
}
