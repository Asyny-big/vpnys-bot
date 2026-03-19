import { promises as fs } from "node:fs";
import * as path from "node:path";

let missingFileWarnPrinted = false;
let lastWarnSignature = "";
let lastKnownGoodSnapshot: Readonly<{ filePath: string; entries: ReadonlyArray<string> }> | null = null;

function getCandidateFiles(): string[] {
  const envPath = (process.env.MOBILE_BYPASS_FILE ?? "").trim();
  const candidates = [
    envPath,
    path.resolve(process.cwd(), "runtime/mobile_bypass.txt"),
    path.resolve(__dirname, "../../runtime/mobile_bypass.txt"),
    path.resolve(__dirname, "../../../runtime/mobile_bypass.txt"),
    "/opt/vpnys-bot/runtime/mobile_bypass.txt",
  ].filter((p) => p.length > 0);

  return Array.from(new Set(candidates));
}

function warnOnce(signature: string, message: string): void {
  if (lastWarnSignature === signature) return;
  lastWarnSignature = signature;
  // eslint-disable-next-line no-console
  console.warn(message);
}

function parseMobileBypass(raw: string, filePath: string): string[] {
  const entries: string[] = [];

  for (const originalLine of raw.split(/\r?\n/g)) {
    const line = originalLine.trim();
    if (!line.length || line.startsWith("#")) continue;

    if (!line.startsWith("vless://")) {
      throw new Error(`Invalid mobile bypass line in ${filePath}: ${line.slice(0, 80)}`);
    }

    entries.push(line);
  }

  return entries;
}

export async function getMobileBypass(): Promise<string[]> {
  const issues: string[] = [];

  for (const filePath of getCandidateFiles()) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const entries = parseMobileBypass(raw, filePath);

      lastKnownGoodSnapshot = { filePath, entries };
      missingFileWarnPrinted = false;
      lastWarnSignature = "";

      return entries;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      issues.push(`${filePath}: ${message}`);
      // Try next candidate path.
    }
  }

  if (issues.length > 0) {
    if (lastKnownGoodSnapshot) {
      warnOnce(
        `fallback:${issues.join("|")}`,
        `[mobileBypass] Failed to load fresh mobile_bypass.txt. Serving last known good snapshot from ${lastKnownGoodSnapshot.filePath}. Issues: ${issues.join("; ")}`,
      );
      return [...lastKnownGoodSnapshot.entries];
    }

    warnOnce(
      `error:${issues.join("|")}`,
      `[mobileBypass] Failed to load mobile_bypass.txt. Issues: ${issues.join("; ")}`,
    );
    return [];
  }

  if (!missingFileWarnPrinted) {
    missingFileWarnPrinted = true;
    warnOnce("missing", `[mobileBypass] mobile_bypass.txt not found. Tried: ${getCandidateFiles().join(", ")}`);
  }

  return [];
}
