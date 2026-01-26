-- CreateTable
CREATE TABLE "AntiAbuseRegistry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegramId" INTEGER NOT NULL,
    "hadTrial" BOOLEAN NOT NULL DEFAULT false,
    "hadReferralBonus" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AntiAbuseRegistry_telegramId_key" ON "AntiAbuseRegistry"("telegramId");

