import { Keyboard } from "grammy";

export const MAIN_KEYBOARD = new Keyboard()
  .text("🏠 Личный кабинет")
  .row()
  .text("📱 Мои устройства")
  .text("🆘 Поддержка")
  .resized();
