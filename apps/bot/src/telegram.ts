/**
 * Telegram Bot API client.
 *
 * Raw `fetch` against the HTTP API rather than a library. The API is a dozen
 * JSON endpoints, and the extension already taught this repo what an unnecessary
 * dependency costs when it breaks in an environment its authors did not test.
 *
 * The transport is injectable so the handlers can be exercised without a token,
 * a network, or a real group full of real people's messages.
 */

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  reply_to_message?: TelegramMessage;
  new_chat_members?: TelegramUser[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export type Transport = (method: string, payload: unknown) => Promise<unknown>;

export function httpTransport(token: string, fetchImpl: typeof fetch = fetch): Transport {
  const base = `https://api.telegram.org/bot${token}`;
  return async (method, payload) => {
    const response = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) throw new Error(body.description ?? `${method} failed`);
    return body.result;
  };
}

export class TelegramClient {
  private transport: Transport;
  private offset = 0;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  async getMe(): Promise<TelegramUser> {
    return (await this.transport("getMe", {})) as TelegramUser;
  }

  /**
   * Long-polls for updates.
   *
   * `allowed_updates` is explicit rather than defaulted: the bot should receive
   * the update types it handles and nothing else, so joining a busy group does
   * not mean streaming every edit, join and poll answer through a process that
   * has no use for them.
   */
  async getUpdates(timeoutSeconds = 30): Promise<TelegramUpdate[]> {
    const updates = (await this.transport("getUpdates", {
      offset: this.offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    })) as TelegramUpdate[];

    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
    }
    return updates;
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyTo?: number,
  ): Promise<TelegramMessage | null> {
    try {
      return (await this.transport("sendMessage", {
        chat_id: chatId,
        text,
        ...(replyTo ? { reply_to_message_id: replyTo } : {}),
        // The bot posts other people's words back into the chat. Link previews
        // on a translated URL would be a second, unasked-for side effect.
        disable_web_page_preview: true,
      })) as TelegramMessage;
    } catch {
      // A chat the bot was removed from, or a rate limit. Never fatal: one
      // undeliverable reply must not stop the poll loop for every other chat.
      return null;
    }
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.transport("setMyCommands", { commands }).catch(() => undefined);
  }
}
