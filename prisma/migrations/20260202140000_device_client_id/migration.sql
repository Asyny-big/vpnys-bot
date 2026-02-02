-- Add clientId field to DeviceConfig for VLESS client UUID
-- Each device gets its own unique VLESS client in 3x-ui
ALTER TABLE "DeviceConfig" ADD COLUMN "clientId" TEXT;

-- Create unique index on clientId (when not null)
CREATE UNIQUE INDEX "DeviceConfig_clientId_key" ON "DeviceConfig"("clientId") WHERE "clientId" IS NOT NULL;
