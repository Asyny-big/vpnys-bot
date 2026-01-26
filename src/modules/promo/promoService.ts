import type { PrismaClient, PromoCode } from "@prisma/client";
import { addDays } from "../../utils/time";
import { isOfferAccepted } from "../../domain/offer";

export type AddPromoParams = Readonly<{
  code: string;
  bonusDays: number;
  maxUses?: number | null;
  expiresAt?: Date | null;
}>;

export type ApplyPromoResult =
  | Readonly<{ status: "applied"; promo: PromoCode; paidUntil: Date }>
  | Readonly<{ status: "offer_required" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "cooldown" }>
  | Readonly<{ status: "expired"; promo: PromoCode }>
  | Readonly<{ status: "exhausted"; promo: PromoCode }>
  | Readonly<{ status: "already_used"; promo: PromoCode }>;

class PromoClaimFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromoClaimFailedError";
  }
}

class PromoAlreadyUsedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromoAlreadyUsedError";
  }
}

function normalizePromoCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export class PromoService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly deps: Readonly<{ offerVersion: string }>,
  ) {}

  normalize(code: string): string {
    return normalizePromoCode(code);
  }

  async addPromo(params: AddPromoParams): Promise<{ ok: true; promo: PromoCode } | { ok: false; reason: "already_exists" }> {
    const code = normalizePromoCode(params.code);
    if (!code.length) throw new Error("Empty promo code");

    const bonusDays = Math.floor(params.bonusDays);
    if (!Number.isFinite(bonusDays) || bonusDays <= 0) throw new Error("Invalid bonusDays");

    const maxUses = params.maxUses === undefined ? undefined : params.maxUses === null ? null : Math.floor(params.maxUses);
    if (maxUses !== undefined && maxUses !== null && (!Number.isFinite(maxUses) || maxUses <= 0)) {
      throw new Error("Invalid maxUses");
    }

    try {
      const promo = await this.prisma.promoCode.create({
        data: {
          code,
          bonusDays,
          maxUses: maxUses ?? null,
          expiresAt: params.expiresAt ?? null,
        },
      });
      return { ok: true, promo };
    } catch (e: any) {
      if (e?.code === "P2002") return { ok: false, reason: "already_exists" };
      throw e;
    }
  }

  async applyPromo(params: { userId: string; code: string }): Promise<ApplyPromoResult> {
    const code = normalizePromoCode(params.code);
    if (!code.length) throw new Error("Empty promo code");

    const now = new Date();
    const cooldownBoundary = new Date(now.getTime() - 60 * 60 * 1000);

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { offerAcceptedAt: true, offerVersion: true },
    });
    if (!user) throw new Error("User not found");
    if (!isOfferAccepted(user as any, this.deps.offerVersion)) return { status: "offer_required" };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const promo = await tx.promoCode.findUnique({ where: { code } });
        if (!promo) return { status: "not_found" };

        if (promo.expiresAt && promo.expiresAt.getTime() <= now.getTime()) return { status: "expired", promo };
        if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) return { status: "exhausted", promo };

        // "Already used" is checked before we reserve the global 1h cooldown window.
        // This keeps lastPromoActivatedAt unchanged for no-op requests.
        const alreadyUsed = await tx.promoCodeUse.findUnique({
          where: { promoId_userId: { promoId: promo.id, userId: params.userId } },
          select: { id: true },
        });
        if (alreadyUsed) return { status: "already_used", promo };

        // Global anti-abuse: allow ANY promo code activation at most once per hour per user.
        // This is race-safe on SQLite because the update acquires a write lock; concurrent attempts serialize.
        const reserved = await tx.user.updateMany({
          where: {
            id: params.userId,
            OR: [{ lastPromoActivatedAt: null }, { lastPromoActivatedAt: { lte: cooldownBoundary } }],
          },
          data: { lastPromoActivatedAt: now },
        });
        if (reserved.count !== 1) return { status: "cooldown" };

        try {
          await tx.promoCodeUse.create({
            data: { promoId: promo.id, userId: params.userId },
          });
        } catch (e: any) {
          // If this happens, rollback the cooldown reservation as well.
          if (e?.code === "P2002") throw new PromoAlreadyUsedError("Promo already used");
          throw e;
        }

        const claimed = await tx.promoCode.updateMany({
          where: {
            id: promo.id,
            ...(promo.expiresAt ? { expiresAt: { gt: now } } : {}),
            ...(promo.maxUses !== null ? { usedCount: { lt: promo.maxUses } } : {}),
          },
          data: { usedCount: { increment: 1 } },
        });
        if (claimed.count !== 1) throw new PromoClaimFailedError("Promo is no longer available");

        const subscription = await tx.subscription.findUnique({ where: { userId: params.userId } });
        if (!subscription) throw new Error("Subscription not found. Require /start first.");

        const paidUntilBase = subscription.paidUntil && subscription.paidUntil.getTime() > now.getTime() ? subscription.paidUntil : now;
        const expiresAtBase = subscription.expiresAt && subscription.expiresAt.getTime() > now.getTime() ? subscription.expiresAt : now;
        const base = paidUntilBase.getTime() > expiresAtBase.getTime() ? paidUntilBase : expiresAtBase;
        const paidUntil = addDays(base, promo.bonusDays);

        await tx.subscription.update({ where: { id: subscription.id }, data: { paidUntil } });

        return { status: "applied", promo, paidUntil };
      });
    } catch (e: any) {
      if (e instanceof PromoAlreadyUsedError) {
        const promo = await this.prisma.promoCode.findUnique({ where: { code } });
        if (!promo) return { status: "not_found" };
        return { status: "already_used", promo };
      }
      if (e instanceof PromoClaimFailedError) {
        const promo = await this.prisma.promoCode.findUnique({ where: { code } });
        if (!promo) return { status: "not_found" };
        const expired = !!promo.expiresAt && promo.expiresAt.getTime() <= now.getTime();
        if (expired) return { status: "expired", promo };
        return { status: "exhausted", promo };
      }
      throw e;
    }
  }
}
