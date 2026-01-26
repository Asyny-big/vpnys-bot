import type { PrismaClient } from "@prisma/client";

export class UserBlockedError extends Error {
  constructor(
    public readonly telegramId: string,
    public readonly reason?: string | null,
  ) {
    super("User is blocked");
    this.name = "UserBlockedError";
  }
}

function parseTelegramIdToBigInt(telegramId: string): bigint {
  const trimmed = telegramId.trim();
  if (!/^\d{1,20}$/.test(trimmed)) throw new Error(`Invalid telegramId: ${telegramId}`);
  return BigInt(trimmed);
}

export class BanService {
  constructor(private readonly prisma: PrismaClient) {}

  async getBlockedUser(telegramId: string): Promise<Readonly<{ reason?: string | null; createdAt: Date }> | null> {
    const telegramIdBig = parseTelegramIdToBigInt(telegramId);
    const row = await this.prisma.blockedUser.findUnique({
      where: { telegramId: telegramIdBig },
      select: { reason: true, createdAt: true },
    });
    return row ? { reason: row.reason ?? null, createdAt: row.createdAt } : null;
  }

  async isBlocked(telegramId: string): Promise<boolean> {
    const telegramIdBig = parseTelegramIdToBigInt(telegramId);
    const row = await this.prisma.blockedUser.findUnique({ where: { telegramId: telegramIdBig }, select: { id: true } });
    return !!row;
  }

  async assertNotBlocked(telegramId: string): Promise<void> {
    const row = await this.getBlockedUser(telegramId);
    if (!row) return;
    throw new UserBlockedError(telegramId, row.reason ?? null);
  }
}

