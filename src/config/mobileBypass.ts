/**
 * Вставляйте сюда список URL (vless:// / trojan://), по одному на строку.
 * Никаких кавычек/запятых не нужно — это обычный многострочный текст.
 *
 * Примечание: часть после `#` (имя) будет автоматически заменена на
 * `🌍 Обход №N` при формировании подписки.
 */
const MOBILE_BYPASS_RAW = `
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@45.139.196.194:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=e499f276e7bd6420&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20%E2%80%94%20%23231
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@45.139.196.195:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=e499f276e7bd6420&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20%E2%80%94%20%23146
vless://fd8972d9-cf5e-11f0-9970-45e1d80c4039@5.253.59.44:8443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=H2_xU4399VG3oT9j7e0Bg8qhescX-CTgpeV1HBoCUWY&security=reality&sid=5d8ae11254&sni=images.apple.com&type=tcp#%F0%9F%87%B3%F0%9F%87%B1%20The%20Netherlands%20%E2%80%94%20%23641
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.176:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2377
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.177:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2374
vless://09e71b35-edaf-483a-bbc8-de5829e7180c@83.166.238.183:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=Qddpg8luihgzgx4g4uMJklXzlrMCd8L1igJSWrRUvSc&security=reality&sid=887c0d72e771a934&sni=m.vk.ru&type=tcp#%F0%9F%87%B5%F0%9F%87%B1%20Poland%20%E2%80%94%20%23753
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.94:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2368
vless://b129eb83-f083-4660-a81a-e5991519a281@spdnet.team-pluss.com:443?security=reality&encryption=none&pbk=ZVfaZBEaPWlmb-Srxncu2WDACudPbm48S1V1Zy2ZcRw&headerType=none&fp=chrome&type=tcp&sni=eh.vk.ru&sid=78523b486884cc4d#%F0%9F%87%B3%F0%9F%87%B1%20The%20Netherlands%20%5BSNI-RU%5D%20eh.vk.ru
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.178:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2365
vless://83df271c-1e50-4847-9beb-a56d0de7e8d3@144.31.100.120:443?encryption=none&fp=chrome&pbk=ihtXyG0UidSbXjvCJXUhABwZGCCB62DUsVBFn_qVd3g&security=reality&sid=352e3a94&sni=www.google.com&type=tcp#%F0%9F%87%B3%F0%9F%87%B1%20The%20Netherlands%20%E2%80%94%20%23623
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.59:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2366
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.174:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2370
vless://09e71b35-edaf-483a-bbc8-de5829e7180c@83.166.238.183:8443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=Qddpg8luihgzgx4g4uMJklXzlrMCd8L1igJSWrRUvSc&security=reality&sid=8f222b3475800821&sni=m.vk.ru&type=tcp#%F0%9F%87%B5%F0%9F%87%B1%20Poland%20%E2%80%94%20%23751
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.172:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2364
vless://45e3b7ad-03b6-42fc-b616-1e92bdd0a5b3@185.234.59.175:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=mLmBhbVFfNuo2eUgBh6r9-5Koz9mUCn3aSzlR6IejUg&security=reality&sid=f79448a30d&sni=hls-svod.itunes.apple.com&type=tcp#%F0%9F%87%B7%F0%9F%87%BA%20UFO%20Hosting%20%E2%80%94%20%2367
`.trim();

export const MOBILE_BYPASS_URLS: ReadonlyArray<string> = MOBILE_BYPASS_RAW
  .split(/\r?\n/g)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));
