-- Add extraDeviceSlots field to User table (default 0 for existing users)
ALTER TABLE "User" ADD COLUMN "extraDeviceSlots" INTEGER NOT NULL DEFAULT 0;

-- Create DeviceConfig table for device fingerprinting
CREATE TABLE "DeviceConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "model" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Create unique index on userId + fingerprint
CREATE UNIQUE INDEX "DeviceConfig_userId_fingerprint_key" ON "DeviceConfig"("userId", "fingerprint");

-- Create index on userId + lastSeenAt for efficient queries
CREATE INDEX "DeviceConfig_userId_lastSeenAt_idx" ON "DeviceConfig"("userId", "lastSeenAt");
