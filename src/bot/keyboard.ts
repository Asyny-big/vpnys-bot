import { Keyboard } from "grammy";

export const MAIN_KEYBOARD = new Keyboard()
  .text("👤 Личный кабинет")
  .row()
  .text("🔐 Моя подписка")
  .text("💳 Оплатить")
  .row()
  .text("🧾 Инструкция")
  .text("ℹ️ О сервисе")
  .resized();
