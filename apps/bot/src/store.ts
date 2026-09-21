import { createRequire } from "node:module";

/**
 * Loaded through `createRequire` rather than a static import.
 *
 * `node:sqlite` shipped after Vite's list of Node builtins was written, so a
 * static import gets rewritten into a bundler resolution that fails. A runtime
 * require is opaque to the bundler and hands it straight to Node, which keeps
 * the real SQL under test instead of swapping in a fake to dodge the toolchain.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = import("node:sqlite").DatabaseSync;

/**
 * Per-chat and per-user state.
 *
 * This is the part of "the bot is infrastructure" that is easy to skip in a
 * plan and impossible to skip in code: something has to remember who reads what,
 * across restarts, and that something is a database with a schema and a
 * migration story. The extension needed none of this.
 *
 * `node:sqlite` rather than a driver: no native build, no dependency, and the
 * data is small and local.
 *
 * What is deliberately NOT stored: message text. Not in a table, not in a log.
 * The bot sees other people's messages and forwards them to a translator; it
 * does not also become a place where they accumulate.
 */

export interface ChatSettings {
  chatId: number;
  /** Eager translation for this chat. Off unless an admin turns it on. */
  eager: boolean;
  /** Whether the consent notice has been posted in this chat. */
  noticeShown: boolean;
}

export interface UserPreference {
  chatId: number;
  userId: number;
  language: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id      INTEGER PRIMARY KEY,
        eager        INTEGER NOT NULL DEFAULT 0,
        notice_shown INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS prefs (
        chat_id  INTEGER NOT NULL,
        user_id  INTEGER NOT NULL,
        language TEXT    NOT NULL,
        PRIMARY KEY (chat_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS usage (
        day   TEXT PRIMARY KEY,
        chars INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  chat(chatId: number): ChatSettings {
    const row = this.db
      .prepare("SELECT chat_id, eager, notice_shown FROM chats WHERE chat_id = ?")
      .get(chatId) as { eager: number; notice_shown: number } | undefined;

    return {
      chatId,
      eager: (row?.eager ?? 0) === 1,
      noticeShown: (row?.notice_shown ?? 0) === 1,
    };
  }

  setEager(chatId: number, eager: boolean): void {
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, eager) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET eager = excluded.eager`,
      )
      .run(chatId, eager ? 1 : 0);
  }

  markNoticeShown(chatId: number): void {
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, notice_shown) VALUES (?, 1)
         ON CONFLICT(chat_id) DO UPDATE SET notice_shown = 1`,
      )
      .run(chatId);
  }

  setLanguage(chatId: number, userId: number, language: string): void {
    this.db
      .prepare(
        `INSERT INTO prefs (chat_id, user_id, language) VALUES (?, ?, ?)
         ON CONFLICT(chat_id, user_id) DO UPDATE SET language = excluded.language`,
      )
      .run(chatId, userId, language);
  }

  languageOf(chatId: number, userId: number): string | null {
    const row = this.db
      .prepare("SELECT language FROM prefs WHERE chat_id = ? AND user_id = ?")
      .get(chatId, userId) as { language: string } | undefined;
    return row?.language ?? null;
  }

  clearLanguage(chatId: number, userId: number): void {
    this.db.prepare("DELETE FROM prefs WHERE chat_id = ? AND user_id = ?").run(chatId, userId);
  }

  /**
   * The distinct languages this chat needs, not the number of members.
   *
   * This is the fan-out bound: a 40-person group with five reading languages
   * costs up to four translations per message, not forty. Getting this wrong
   * is what makes a bot's cost scale with membership instead of with diversity.
   */
  targetLanguages(chatId: number): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT language FROM prefs WHERE chat_id = ? ORDER BY language")
      .all(chatId) as { language: string }[];
    return rows.map((r) => r.language);
  }

  memberCount(chatId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM prefs WHERE chat_id = ?")
      .get(chatId) as { n: number };
    return row.n;
  }

  /** Paid characters used today. Self-hosted translation is not metered. */
  usageToday(day: string): number {
    const row = this.db.prepare("SELECT chars FROM usage WHERE day = ?").get(day) as
      | { chars: number }
      | undefined;
    return row?.chars ?? 0;
  }

  recordUsage(day: string, chars: number): void {
    this.db
      .prepare(
        `INSERT INTO usage (day, chars) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET chars = chars + excluded.chars`,
      )
      .run(day, Math.max(0, chars));
  }

  close(): void {
    this.db.close();
  }
}
