import * as fs from "node:fs";
import * as path from "node:path";

let missingFileWarnPrinted = false;

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

export function getMobileBypass(): string[] {
  for (const filePath of getCandidateFiles()) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return raw
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !line.startsWith("#"))
        .filter((line) => line.startsWith("vless://"));
    } catch {
      // Try next candidate path.
    }
  }

  if (!missingFileWarnPrinted) {
    missingFileWarnPrinted = true;
    // eslint-disable-next-line no-console
    console.warn(`[mobileBypass] mobile_bypass.txt not found. Tried: ${getCandidateFiles().join(", ")}`);
  }

  return [];
}
