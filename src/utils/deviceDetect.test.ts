import assert from "node:assert/strict";
import test from "node:test";

import {
  hashIdentityToken,
  parseHappHeaders,
  parseHappUserAgent,
} from "./deviceDetect";

test("parseHappUserAgent recognises the Happ Android 3.x UA format", () => {
  const result = parseHappUserAgent("Happ/3.20.4/Android/17782185961531805698");
  assert.equal(result.isHapp, true);
  assert.equal(result.version, "3.20.4");
  assert.equal(result.platform, "Android");
  assert.equal(result.installToken, "17782185961531805698");
});

test("parseHappUserAgent recognises the Happ iOS 4.x UA format", () => {
  const result = parseHappUserAgent("Happ/4.9.0/ios/2605051739663");
  assert.equal(result.isHapp, true);
  assert.equal(result.version, "4.9.0");
  assert.equal(result.platform, "ios");
  assert.equal(result.installToken, "2605051739663");
});

test("parseHappUserAgent handles legacy Happ UA without trailing token", () => {
  const result = parseHappUserAgent("Happ/3.13.0");
  assert.equal(result.isHapp, true);
  assert.equal(result.version, "3.13.0");
  assert.equal(result.platform, null);
  assert.equal(result.installToken, null);
});

test("parseHappUserAgent returns isHapp=false for non-Happ UA", () => {
  const result = parseHappUserAgent("Mozilla/5.0 (Linux; Android 13; Redmi Note 8 Pro) AppleWebKit/537.36");
  assert.equal(result.isHapp, false);
  assert.equal(result.version, null);
  assert.equal(result.platform, null);
  assert.equal(result.installToken, null);
});

test("parseHappUserAgent handles null/undefined/empty input", () => {
  for (const input of [null, undefined, "", "   "]) {
    const result = parseHappUserAgent(input as string | null | undefined);
    assert.equal(result.isHapp, false);
    assert.equal(result.version, null);
    assert.equal(result.platform, null);
    assert.equal(result.installToken, null);
  }
});

test("parseHappUserAgent caps an excessively long install token", () => {
  const longToken = "x".repeat(500);
  const result = parseHappUserAgent(`Happ/3.20.4/Android/${longToken}`);
  assert.equal(result.isHapp, true);
  assert.ok(result.installToken);
  assert.ok(
    result.installToken!.length <= 128,
    `install token should be capped, got length=${result.installToken!.length}`,
  );
});

test("parseHappHeaders extracts the documented Happ identity headers", () => {
  const headers = {
    "x-hwid": "abc123stable",
    "x-device-os": "Android",
    "x-ver-os": "14",
    "x-device-model": "Redmi Note 8 Pro",
    "x-device-locale": "ru",
    "user-agent": "Happ/3.20.4/Android/17782185961531805698",
  };
  const result = parseHappHeaders(headers);
  assert.equal(result.hwid, "abc123stable");
  assert.equal(result.deviceOs, "Android");
  assert.equal(result.osVersion, "14");
  assert.equal(result.deviceModel, "Redmi Note 8 Pro");
  assert.equal(result.deviceLocale, "ru");
  assert.equal(result.deviceInfo, null);
  assert.equal(result.anyPresent, true);
});

test("parseHappHeaders falls back to legacy X-Device-Info header", () => {
  const headers = {
    "x-device-info": "Android 14, Redmi Note 8 Pro",
  };
  const result = parseHappHeaders(headers);
  assert.equal(result.hwid, null);
  assert.equal(result.deviceInfo, "Android 14, Redmi Note 8 Pro");
  assert.equal(result.anyPresent, true);
});

test("parseHappHeaders reports anyPresent=false when no Happ headers are sent", () => {
  const headers = {
    "user-agent": "Mozilla/5.0",
    "accept": "*/*",
  };
  const result = parseHappHeaders(headers);
  assert.equal(result.hwid, null);
  assert.equal(result.deviceOs, null);
  assert.equal(result.deviceModel, null);
  assert.equal(result.anyPresent, false);
});

test("parseHappHeaders is case-insensitive and tolerates array values", () => {
  const headers = {
    "X-Hwid": "uppercase-hwid",
    "X-Device-Os": ["Android", "ignored"],
  } as unknown as Record<string, string | string[] | undefined>;
  const result = parseHappHeaders(headers);
  assert.equal(result.hwid, "uppercase-hwid");
  assert.equal(result.deviceOs, "Android");
});

test("parseHappHeaders treats blank/whitespace values as absent", () => {
  const headers = {
    "x-hwid": "   ",
    "x-device-model": "",
  };
  const result = parseHappHeaders(headers);
  assert.equal(result.hwid, null);
  assert.equal(result.deviceModel, null);
  assert.equal(result.anyPresent, false);
});

test("parseHappHeaders caps absurdly long header values", () => {
  const headers = {
    "x-hwid": "a".repeat(1000),
  };
  const result = parseHappHeaders(headers);
  assert.ok(result.hwid);
  assert.ok(result.hwid!.length <= 256, `hwid should be capped, got length=${result.hwid!.length}`);
});

test("parseHappHeaders returns the no-headers shape for null input", () => {
  const result = parseHappHeaders(null);
  assert.equal(result.anyPresent, false);
  assert.equal(result.hwid, null);
  assert.equal(result.deviceOs, null);
});

test("hashIdentityToken produces a stable short sha256 prefix", () => {
  const a = hashIdentityToken("abc123stable");
  const b = hashIdentityToken("abc123stable");
  assert.equal(a, b);
  assert.ok(a);
  assert.equal(a!.length, 16);
  assert.match(a!, /^[0-9a-f]{16}$/);

  const c = hashIdentityToken("different");
  assert.notEqual(a, c);
});

test("hashIdentityToken returns null for null/empty input", () => {
  assert.equal(hashIdentityToken(null), null);
  assert.equal(hashIdentityToken(undefined), null);
  assert.equal(hashIdentityToken(""), null);
});
