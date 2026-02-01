/**
 * Device detection utility for User-Agent parsing.
 * Safe for production use - only logs, no DB writes.
 */

export interface DeviceInfo {
  platform: "Android" | "iOS" | "Windows" | "macOS" | "Linux" | "Unknown";
  model: string | null;
  rawUserAgent: string;
  /** Source of model info: 'ua' (User-Agent), 'hints' (Client Hints), or null */
  modelSource: "ua" | "hints" | null;
}

/**
 * Headers that may contain Client Hints.
 * Modern browsers (Chrome 89+) can send device model via these headers
 * if the server requests them.
 */
export interface ClientHintsHeaders {
  "sec-ch-ua-platform"?: string;
  "sec-ch-ua-model"?: string;
  "sec-ch-ua-platform-version"?: string;
  "user-agent"?: string;
  [key: string]: string | undefined;
}

/**
 * Parse User-Agent string to extract platform and device model.
 * Focuses on mobile devices (Android/iOS) as primary use case.
 */
export function parseUserAgent(userAgent: string | undefined | null): DeviceInfo {
  const ua = userAgent?.trim() ?? "";

  if (!ua) {
    return { platform: "Unknown", model: null, rawUserAgent: "", modelSource: null };
  }

  // Detect platform
  let platform: DeviceInfo["platform"] = "Unknown";
  let model: string | null = null;

  if (/Android/i.test(ua)) {
    platform = "Android";
    // Extract Android device model
    // Format: "Android X.X; <model>" or "Android X.X; <locale>; <model>"
    // Examples:
    //   Mozilla/5.0 (Linux; Android 13; Redmi Note 8 Pro) ...
    //   Mozilla/5.0 (Linux; Android 12; SM-G991B) ...
    //   Mozilla/5.0 (Linux; Android 10; K) ... (generic/reduced)
    const androidMatch = ua.match(/Android\s*[\d.]*;\s*(?:[a-z]{2}[-_][a-z]{2};\s*)?([^);]+)/i);
    if (androidMatch?.[1]) {
      const rawModel = androidMatch[1].trim();
      // Filter out generic identifiers (Android 10+ privacy)
      if (rawModel && !isGenericAndroidModel(rawModel)) {
        model = rawModel;
      }
    }
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    platform = "iOS";
    // iOS doesn't expose specific device model in UA (privacy)
    // We can only detect device type, not model number (iPhone 15, etc.)
    if (/iPad/i.test(ua)) {
      model = "iPad";
    } else if (/iPhone/i.test(ua)) {
      model = "iPhone";
    } else if (/iPod/i.test(ua)) {
      model = "iPod";
    }
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    platform = "macOS";
    // macOS UA doesn't contain device model (MacBook Pro, iMac, etc.)
    model = null;
  } else if (/Windows/i.test(ua)) {
    platform = "Windows";
    // Windows UA doesn't contain device model
    model = null;
  } else if (/Linux/i.test(ua)) {
    platform = "Linux";
  }

  return { platform, model, rawUserAgent: ua, modelSource: model ? "ua" : null };
}

/**
 * Check if Android model string is a generic/reduced identifier
 * (Android 10+ privacy feature)
 */
function isGenericAndroidModel(model: string): boolean {
  const normalized = model.toLowerCase().trim();
  return (
    normalized === "k" ||
    normalized === "mobile" ||
    normalized === "wv" ||
    normalized === "webview" ||
    model.length <= 1
  );
}

/**
 * Parse device info with Client Hints support (modern browsers).
 * Client Hints provide more accurate device info on Android 10+.
 * 
 * To enable Client Hints, server should send response header:
 * Accept-CH: Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version
 */
export function parseWithClientHints(headers: ClientHintsHeaders): DeviceInfo {
  // First, parse standard User-Agent
  const baseInfo = parseUserAgent(headers["user-agent"]);

  // Try to get platform from Client Hints
  const hintPlatform = headers["sec-ch-ua-platform"]?.replace(/"/g, "").trim();
  if (hintPlatform) {
    if (/android/i.test(hintPlatform)) baseInfo.platform = "Android";
    else if (/ios/i.test(hintPlatform)) baseInfo.platform = "iOS";
    else if (/windows/i.test(hintPlatform)) baseInfo.platform = "Windows";
    else if (/macos/i.test(hintPlatform)) baseInfo.platform = "macOS";
    else if (/linux/i.test(hintPlatform)) baseInfo.platform = "Linux";
  }

  // Try to get model from Client Hints (works on Android 10+ with Chrome)
  const hintModel = headers["sec-ch-ua-model"]?.replace(/"/g, "").trim();
  if (hintModel && hintModel.length > 1) {
    baseInfo.model = hintModel;
    baseInfo.modelSource = "hints";
  }

  return baseInfo;
}

/**
 * Log device info to console in the expected format.
 * Only logs if User-Agent is present.
 */
export function logDeviceInfo(deviceInfo: DeviceInfo, context?: string): void {
  if (!deviceInfo.rawUserAgent) {
    return;
  }

  const prefix = context ? `[${context}] ` : "";
  console.log(`${prefix}RAW UA: ${deviceInfo.rawUserAgent}`);
  console.log(`${prefix}PLATFORM: ${deviceInfo.platform}`);
  console.log(`${prefix}MODEL: ${deviceInfo.model ?? "Unknown"}${deviceInfo.modelSource === "hints" ? " (from Client Hints)" : ""}`);
}

/**
 * Convenience function to parse UA and log in one call.
 * Supports both standard UA and Client Hints.
 */
export function detectAndLogDevice(
  headers: string | ClientHintsHeaders | undefined | null,
  context?: string,
): DeviceInfo {
  // If passed a string, treat as User-Agent only
  const info = typeof headers === "string" || headers === null || headers === undefined
    ? parseUserAgent(headers)
    : parseWithClientHints(headers);
  
  logDeviceInfo(info, context);
  return info;
}
