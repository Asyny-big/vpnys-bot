-- This migration adds:
-- - User.lastPromoActivatedAt (anti-abuse: global 1h promo cooldown)
-- - User referral fields (referredById + referralCode)
-- - Referral table (inviter<->invited + rewardGiven flag)
--
-- SQLite requires table re-creation to add NOT NULL columns and new FK constraints.

PRAGMA foreign_keys=OFF;

-- RedefineTable
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "trialGrantedAt" DATETIME,
    "offerAcceptedAt" DATETIME,
    "offerVersion" TEXT,
    "lastPromoActivatedAt" DATETIME,
    "referredById" TEXT,
    "referralCode" TEXT NOT NULL,
    CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_User" ("id", "telegramId", "createdAt", "updatedAt", "trialGrantedAt", "offerAcceptedAt", "offerVersion", "lastPromoActivatedAt", "referredById", "referralCode")
SELECT
    "id",
    "telegramId",
    "createdAt",
    "updatedAt",
    "trialGrantedAt",
    "offerAcceptedAt",
    "offerVersion",
    NULL,
    NULL,
    "telegramId"
FROM "User";

DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";

-- Re-create indexes (dropped with the table).
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");
CREATE INDEX "User_referredById_idx" ON "User"("referredById");

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "inviterId" TEXT NOT NULL,
    "invitedId" TEXT NOT NULL,
    "rewardGiven" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Referral_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Referral_invitedId_fkey" FOREIGN KEY ("invitedId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_invitedId_key" ON "Referral"("invitedId");
CREATE INDEX "Referral_inviterId_createdAt_idx" ON "Referral"("inviterId", "createdAt");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;

