/**
 * Bot configuration.
 *
 * Validated loudly at startup rather than discovered at the first translation:
 * a bot that starts, joins a group and then fails on every message is worse
 * than one that refuses to start.
 */
export interface BotConfig {
  token: string;
  /** Where translations come from. See providers.ts for why the order matters. */
  selfHostedUrl?: string;
  deeplKey?: string;
  /**
   * Eager translation — translating every message whether or not anyone asked.
   *
   * Off by default and per-chat opt-in, because a bot has no viewport to gate
   * on. Demand gating is its cost defence; eager mode removes it.
   */
  allowEager: boolean;
  dbPath: string;
  /** Hard ceiling on paid characters per day across all chats. */
  dailyCharLimit: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const token = env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and export its token.",
    );
  }

  const selfHostedUrl = env["NLLB_URL"];
  const deeplKey = env["DEEPL_API_KEY"];

  if (!selfHostedUrl && !deeplKey) {
    // The point of the check: on a server there is no built-in translator, so
    // unlike the extension this cannot fall back to something free and local.
    // Every translation is either self-hosted or paid, and a bot with neither
    // configured can do nothing at all.
    throw new ConfigError(
      "No translator configured. Set NLLB_URL (self-hosted, free at the margin) " +
        "or DEEPL_API_KEY (paid per character). There is no on-device option on a server.",
    );
  }

  return {
    token,
    ...(selfHostedUrl ? { selfHostedUrl } : {}),
    ...(deeplKey ? { deeplKey } : {}),
    allowEager: env["ALLOW_EAGER"] === "true",
    dbPath: env["DB_PATH"] ?? "polyglot-bot.db",
    dailyCharLimit: Number(env["DAILY_CHAR_LIMIT"] ?? 200_000),
  };
}
