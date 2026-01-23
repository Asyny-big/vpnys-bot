import { Keyboard } from "grammy";

export const MAIN_KEYBOARD = new Keyboard()
  .text("👤 Личный кабинет")
  .row()
  .text("🔐 Моя подписка")
  .text("💳 Оформить подписку")
  .row()
  .text("🧾 Инструкция")
  .text("ℹ️ О сервисе")
  .row()
  .text("🆘 Написать в поддержку")
  .resized();
