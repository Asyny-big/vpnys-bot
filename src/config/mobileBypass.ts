import * as fs from "node:fs";
import * as path from "node:path";

const MOBILE_BYPASS_FILE = path.resolve(__dirname, "../../runtime/mobile_bypass.txt");

export function getMobileBypass(): string[] {
  try {
    const raw = fs.readFileSync(MOBILE_BYPASS_FILE, "utf8");
    return raw
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !line.startsWith("#"))
      .filter((line) => line.startsWith("vless://"));
  } catch {
    return [];
  }
}
