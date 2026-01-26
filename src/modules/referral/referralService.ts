import type { PrismaClient } from "@prisma/client";
import { addDays } from "../../utils/time";
import { SubscriptionService } from "../subscription/subscriptionService";
import type { BanService } from "../ban/banService";
import type { AntiAbuseService } from "../antiAbuse/antiAbuseService";

export const REFERRAL_REWARD_DAYS = 7;

export type GrantReferralRewardResult =
  | Readonly<{ status: "applied"; inviterTelegramId: string }>
  | Readonly<{ status: "skipped"; reason: "no_referrer" | "inviter_not_found" | "self_referral" | "already_rewarded" | "missing_subscription" | "blocked" | "anti_abuse" }>;

function computePaidUntilBase(subscription: { expiresAt: Date | null; paidUntil: Date | null }, now: Date): Date {
  const paidUntilBase = subscription.paidUntil && subscription.paidUntil.getTime() > now.getTime() ? subscription.paidUntil : now;
  const expiresAtBase = subscription.expiresAt && subscription.expiresAt.getTime() > now.getTime() ? subscription.expiresAt : now;
  return paidUntilBase.getTime() > expiresAtBase.getTime() ? paidUntilBase : expiresAtBase;
}

export class ReferralService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly subscriptions: SubscriptionService,
    private readonly bans: BanService,
    private readonly antiAbuse: AntiAbuseService,
  ) {}

  /**
   * Grants a referral reward (+7 days) to BOTH inviter and invited, strictly once per invited user.
   *
   * Anti-abuse guarantees:
   * - Existing users can't be rewarded (caller must only invoke on new registration).
   * - Self-referral is rejected.
   * - Idempotent: Referral.invitedId is UNIQUE and rewardGiven is set in the same DB transaction.
   */
  async grantRegistrationRewardIfEligible(params: { invitedUserId: string }): Promise<GrantReferralRewardResult> {
    const invited = await this.prisma.user.findUnique({ where: { id: params.invitedUserId } });
    if (!invited?.referredById) return { status: "skipped", reason: "no_referrer" };
    if (invited.referredById === invited.id) return { status: "skipped", reason: "self_referral" };
    if (await this.bans.isBlocked(invited.telegramId)) return { status: "skipped", reason: "blocked" };

    const inviter = await this.prisma.user.findUnique({
      where: { id: invited.referredById },
    });
    if (!inviter) return { status: "skipped", reason: "inviter_not_found" };
    if (await this.bans.isBlocked(inviter.telegramId)) return { status: "skipped", reason: "blocked" };

    // Ensure subscriptions exist (may call 3x-ui on first use).
    // This is intentionally done outside the reward transaction.
    try {
      await this.subscriptions.ensureForUser(inviter);
      await this.subscriptions.ensureForUser(invited);
    } catch {
      return { status: "skipped", reason: "missing_subscription" };
    }

    const now = new Date();
    class ReferralAlreadyRewardedError extends Error {
      constructor() {
        super("Referral already rewarded");
        this.name = "ReferralAlreadyRewardedError";
      }
    }

    const reward = await this.prisma.$transaction(async (tx) => {
      let invitedTelegramIdBig: bigint;
      try {
        invitedTelegramIdBig = BigInt(invited.telegramId);
      } catch {
        throw new Error(`Invalid invited.telegramId: ${invited.telegramId}`);
      }

      const anti = await tx.antiAbuseRegistry.upsert({
        where: { telegramId: invitedTelegramIdBig },
        create: { telegramId: invitedTelegramIdBig, hadTrial: false, hadReferralBonus: false },
        update: {},
        select: { hadReferralBonus: true },
      });
      if (anti.hadReferralBonus) return { status: "skipped", reason: "anti_abuse" } as const;

      let referral = await tx.referral.findUnique({
        where: { invitedId: invited.id },
        select: { id: true, rewardGiven: true },
      });

      if (!referral) {
        try {
          referral = await tx.referral.create({
            data: { inviterId: inviter.id, invitedId: invited.id, rewardGiven: false },
            select: { id: true, rewardGiven: true },
          });
        } catch (e: any) {
          // Race-safe: invitedId is UNIQUE; concurrent attempts may create the row.
          if (e?.code !== "P2002") throw e;
          referral = await tx.referral.findUnique({
            where: { invitedId: invited.id },
            select: { id: true, rewardGiven: true },
          });
        }
      }

      if (!referral) return { status: "skipped", reason: "already_rewarded" } as const;
      if (referral.rewardGiven) return { status: "skipped", reason: "already_rewarded" } as const;

      const inviterSub = await tx.subscription.findUnique({ where: { userId: inviter.id } });
      const invitedSub = await tx.subscription.findUnique({ where: { userId: invited.id } });
      if (!inviterSub || !invitedSub) return { status: "skipped", reason: "missing_subscription" } as const;

      const inviterPaidUntil = addDays(computePaidUntilBase(inviterSub, now), REFERRAL_REWARD_DAYS);
      const invitedPaidUntil = addDays(computePaidUntilBase(invitedSub, now), REFERRAL_REWARD_DAYS);

      await tx.subscription.update({ where: { id: inviterSub.id }, data: { paidUntil: inviterPaidUntil } });
      await tx.subscription.update({ where: { id: invitedSub.id }, data: { paidUntil: invitedPaidUntil } });

      // Finalize atomically. If another transaction already finalized, rollback the whole transaction.
      const finalized = await tx.referral.updateMany({
        where: { id: referral.id, rewardGiven: false },
        data: { rewardGiven: true },
      });
      if (finalized.count !== 1) throw new ReferralAlreadyRewardedError();

      await this.antiAbuse.markReferralBonusGrantedTx(tx, invited.telegramId);
      return { status: "applied" } as const;
    }).catch((e: any) => {
      if (e?.name === "ReferralAlreadyRewardedError") {
        return { status: "skipped", reason: "already_rewarded" } as const;
      }
      throw e;
    });

    if (reward.status !== "applied") return reward;

    // Best-effort: propagate paidUntil to 3x-ui right away.
    await this.subscriptions.syncFromXui(inviter).catch(() => {});
    await this.subscriptions.syncFromXui(invited).catch(() => {});

    return { status: "applied", inviterTelegramId: inviter.telegramId };
  }

  async listInvitedFriends(params: { inviterUserId: string; take?: number }): Promise<
    ReadonlyArray<
      Readonly<{
        invitedTelegramId: string;
        invitedCreatedAt: Date;
        rewardGiven: boolean;
        referredAt: Date;
      }>
    >
  > {
    const take = params.take ?? 50;
    const rows = await this.prisma.referral.findMany({
      where: { inviterId: params.inviterUserId },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        rewardGiven: true,
        createdAt: true,
        invited: { select: { telegramId: true, createdAt: true } },
      },
    });

    return rows.map((row) => ({
      invitedTelegramId: row.invited.telegramId,
      invitedCreatedAt: row.invited.createdAt,
      rewardGiven: row.rewardGiven,
      referredAt: row.createdAt,
    }));
  }
}
