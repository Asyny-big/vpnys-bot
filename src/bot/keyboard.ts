import { Keyboard } from "grammy";

export const MAIN_KEYBOARD = new Keyboard()
  .text("🔐 Подключить VPN")
  .row()
  .text("⏳ Моя подписка")
  .row()
  .text("💳 Оплатить")
  .row()
  .text("👥 Реферальная программа")
  .row()
  .text("ℹ️ О сервисе")
  .row()
  .text("📱 Устройства")
  .resized();
