/**
 * Simple Telegram message sender using HTTP API.
 * This is a minimal implementation specifically for the worker to send expiration notices.
 */
export async function sendTelegramMessage(
    botToken: string,
    chatId: string,
    text: string,
    options?: { parseMode?: "HTML" | "Markdown" },
): Promise<boolean> {
    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const body = {
            chat_id: chatId,
            text,
            parse_mode: options?.parseMode,
        };

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        return response.ok;
    } catch {
        return false;
    }
}
