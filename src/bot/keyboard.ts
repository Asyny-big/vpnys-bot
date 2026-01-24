import { Keyboard } from "grammy";

export const MAIN_KEYBOARD = new Keyboard()
  .text("🏠 Личный кабинет")
  .row()
  .text("🚀 Подключить VPN")
  .row()
  .text("📱 Устройства")
  .text("💳 Подписка")
  .row()
  .text("📄 Оферта")
  .row()
  .text("🆘 Поддержка")
  .resized();
