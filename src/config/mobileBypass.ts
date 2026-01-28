/**
 * Вставляйте сюда список URL (vless:// / trojan://), по одному на строку.
 * Никаких кавычек/запятых не нужно — это обычный многострочный текст.
 *
 * Примечание: часть после `#` (имя) будет автоматически заменена на
 * `🌍 Обход №N` при формировании подписки.
 */
const MOBILE_BYPASS_RAW = `
vless://51d68902-063d-43c4-a29a-63b5561b4c96@144.31.90.119:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=1zFPeiVWBcIJay74YmHtU38qRsUQGpMqG6zEAGu_BHM&security=reality&sid=15affa0af66dfc79&sni=deepl.com&type=tcp#%F0%9F%87%AB%F0%9F%87%AE%20Finland%20%5B%2ACIDR%5D
vless://51d68902-063d-43c4-a29a-63b5561b4c96@85.192.49.243:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=1zFPeiVWBcIJay74YmHtU38qRsUQGpMqG6zEAGu_BHM&security=reality&sid=15affa0af66dfc79&sni=deepl.com&type=tcp#%F0%9F%87%AB%F0%9F%87%AE%20Finland%20%E2%80%94%20%23505
vless://ba9ddd0d-5ffd-4d40-b76d-df32ecb092a1@193.23.200.223:443?encryption=none&security=tls&sni=secdn16.suio.me&type=tcp#%F0%9F%87%B8%F0%9F%87%AA%20Sweden%20%E2%80%94%20%23997
vless://d64a9add-5db5-4e28-aef1-8b109cbef4f2@access-lv10.agveit.pro:443?type=tcp&security=reality&encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=B1RgXN1uLE1Aq3bspliRl7u4m8A2Ijvwy4UDuSFgjhw&sid=d553dfdcc0c4cfc0&sni=queuev4.vk.com#%F0%9F%87%B1%F0%9F%87%BB%20Latvia%20%5BSNI-RU%5D%20queuev4.vk.com
vless://35d926e8-3ff1-48d9-8502-a09133f2ff61@cdn1.lagzero.ru:443?type=xhttp&security=reality&encryption=none&fp=chrome&pbk=2jFDFhGDnofK5-_zKTu7foAD-3g2UTfWAhpjeTHhuDU&sid=a7f3c91d5b2e8f41&sni=cdn1.lagzero.ru&mode=auto#0903 | 🌐 Unknown | VLESS | TG: @YoutubeUnBlockRu
vless://f4fec1b0-a67e-4967-b9ea-0bd832b57a4d@138.124.75.64:8443?encryption=none&fp=chrome&pbk=upDCW94g-pSYQrmXvOrTVYlwBUrSKhYFF9QwrqObdVo&security=reality&sid=3ca620a7ed5f3196&sni=sun6-21.userapi.com&type=tcp#%F0%9F%87%BA%F0%9F%87%B8%20United%20States%20%5BSNI-RU%5D%20sun6-21.userapi.com
vless://f4fec1b0-a67e-4967-b9ea-0bd832b57a4d@94.156.236.223:8443?encryption=none&fp=chrome&pbk=upDCW94g-pSYQrmXvOrTVYlwBUrSKhYFF9QwrqObdVo&security=reality&sid=3ca620a7ed5f3196&sni=sun6-21.userapi.com&type=tcp#%F0%9F%87%AA%F0%9F%87%AA%20Estonia%20%5BSNI-RU%5D%20sun6-21.userapi.com
vless://d64a9add-5db5-4e28-aef1-8b109cbef4f2@169.40.0.185:443?encryption=none&flow=xtls-rprx-vision&fp=chrome&pbk=B1RgXN1uLE1Aq3bspliRl7u4m8A2Ijvwy4UDuSFgjhw&security=reality&sid=d553dfdcc0c4cfc0&sni=queuev4.vk.com&type=tcp#%F0%9F%87%B1%F0%9F%87%BB%20Latvia%20%5BSNI-RU%5D%20queuev4.vk.com
vless://35d926e8-3ff1-48d9-8502-a09133f2ff61@85.155.230.127:443?encryption=none&fp=chrome&mode=auto&pbk=2jFDFhGDnofK5-_zKTu7foAD-3g2UTfWAhpjeTHhuDU&security=reality&sid=a7f3c91d5b2e8f41&sni=cdn1.lagzero.ru&type=xhttp#%F0%9F%87%B5%F0%9F%87%B1%20Poland%20%E2%80%94%20%23954
vless://044818b4-a05f-5813-b8f5-63e1e4615827@194.107.126.214:8443?encryption=none&fp=chrome&mode=auto&path=%2F&pbk=JOJ9C3bZafgM5-cMNWQQIgsU7rGSMhXOz89852K-EwQ&security=reality&sid=c39392324d01&sni=vk.com&type=xhttp#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20%5BSNI-RU%5D%20vk.com
vless://f4fec1b0-a67e-4967-b9ea-0bd832b57a4d@185.255.178.82:8443?encryption=none&fp=chrome&pbk=upDCW94g-pSYQrmXvOrTVYlwBUrSKhYFF9QwrqObdVo&security=reality&sid=3ca620a7ed5f3196&sni=sun6-21.userapi.com&type=tcp#%F0%9F%87%AA%F0%9F%87%AA%20Estonia%20%5BSNI-RU%5D%20sun6-21.userapi.com
vless://f4fec1b0-a67e-4967-b9ea-0bd832b57a4d@38.180.45.221:8443?encryption=none&fp=chrome&pbk=upDCW94g-pSYQrmXvOrTVYlwBUrSKhYFF9QwrqObdVo&security=reality&sid=3ca620a7ed5f3196&sni=sun6-21.userapi.com&type=tcp#%F0%9F%87%AA%F0%9F%87%AA%20Estonia%20%5BSNI-RU%5D%20sun6-21.userapi.com
vless://f4fec1b0-a67e-4967-b9ea-0bd832b57a4d@91.211.114.150:8443?encryption=none&fp=chrome&pbk=upDCW94g-pSYQrmXvOrTVYlwBUrSKhYFF9QwrqObdVo&security=reality&sid=3ca620a7ed5f3196&sni=sun6-21.userapi.com&type=tcp#%F0%9F%87%AB%F0%9F%87%AE%20Finland%20%E2%80%94%20%23520
vless://f4fec1b0-a67e-4967-b9ea-0bd832b57a4d@38.180.45.208:8443?encryption=none&fp=chrome&pbk=upDCW94g-pSYQrmXvOrTVYlwBUrSKhYFF9QwrqObdVo&security=reality&sid=3ca620a7ed5f3196&sni=sun6-21.userapi.com&type=tcp#%F0%9F%87%AA%F0%9F%87%AA%20Estonia%20%5BSNI-RU%5D%20sun6-21.userapi.com
vless://f4fec1b0-a67e-4967-b9ea-0bd832b57a4d@138.124.75.233:8443?encryption=none&fp=chrome&pbk=upDCW94g-pSYQrmXvOrTVYlwBUrSKhYFF9QwrqObdVo&security=reality&sid=3ca620a7ed5f3196&sni=sun6-21.userapi.com&type=tcp#%F0%9F%87%BA%F0%9F%87%B8%20United%20States%20%5BSNI-RU%5D%20sun6-21.userapi.com
`.trim();

export const MOBILE_BYPASS_URLS: ReadonlyArray<string> = MOBILE_BYPASS_RAW
  .split(/\r?\n/g)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));
