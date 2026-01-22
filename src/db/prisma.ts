import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export function getPrisma(): PrismaClient {
  if (process.env.NODE_ENV === "production") return new PrismaClient();
  if (!globalThis.__prisma) globalThis.__prisma = new PrismaClient();
  return globalThis.__prisma;
}

