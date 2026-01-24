-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "trialGrantedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "xuiInboundId" INTEGER NOT NULL,
    "xuiClientUuid" TEXT NOT NULL,
    "xuiSubscriptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deviceLimit" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" DATETIME,
    "paidUntil" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "type" TEXT NOT NULL DEFAULT 'SUBSCRIPTION',
    "planDays" INTEGER NOT NULL,
    "deviceSlots" INTEGER NOT NULL DEFAULT 0,
    "amountRub" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    "processingAt" DATETIME,
    "appliedAt" DATETIME,
    "targetExpiresAt" DATETIME,
    "targetDeviceLimit" INTEGER,
    "rawWebhook" TEXT,
    CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "bonusDays" INTEGER NOT NULL,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PromoCodeUse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "promoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromoCodeUse_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "PromoCode" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PromoCodeUse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_xuiClientUuid_key" ON "Subscription"("xuiClientUuid");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_xuiSubscriptionId_key" ON "Subscription"("xuiSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_expiresAt_idx" ON "Subscription"("expiresAt");

-- CreateIndex
CREATE INDEX "Subscription_paidUntil_idx" ON "Subscription"("paidUntil");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerPaymentId_key" ON "Payment"("provider", "providerPaymentId");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCodeUse_promoId_userId_key" ON "PromoCodeUse"("promoId", "userId");

-- CreateIndex
CREATE INDEX "PromoCodeUse_userId_usedAt_idx" ON "PromoCodeUse"("userId", "usedAt");

