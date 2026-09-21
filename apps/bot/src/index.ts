#!/usr/bin/env node
import { loadConfig, ConfigError } from "./config.js";
import { Handlers, HELP } from "./handlers.js";
import { Store } from "./store.js";
import { httpTransport, TelegramClient } from "./telegram.js";
import { DeepLProvider, SelfHostedProvider, TranslationService, type Provider } from "./translate.js";

/**
 * Entry point.
 *
 * "The bot is infrastructure" is a sentence in the plan and a process here:
 * something has to stay running, hold a database handle, survive a translator
 * going down, and shut down without losing state. None of that existed for the
 * extension, where the browser owned the lifecycle.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const client = new TelegramClient(httpTransport(config.token));

  const providers: Provider[] = [];
  if (config.selfHostedUrl) {
    const selfHosted = new SelfHostedProvider(config.selfHostedUrl);
    if (await selfHosted.healthy()) {
      providers.push(selfHosted);
      console.log(`self-hosted translator: up at ${config.selfHostedUrl}`);
    } else {
      // Loud, because the difference is the entire cost model: without it,
      // every translation is billed per character.
      console.warn(
        `self-hosted translator at ${config.selfHostedUrl} is NOT responding. ` +
          "Falling back to paid translation.",
      );
    }
  }
  if (config.deeplKey) providers.push(new DeepLProvider(config.deeplKey));

  if (providers.length === 0) {
    throw new ConfigError("No translator is reachable. Refusing to start.");
  }

  const me = await client.getMe();
  const handlers = new Handlers({
    client,
    store,
    service: new TranslationService({
      providers,
      store,
      dailyCharLimit: config.dailyCharLimit,
    }),
    botId: me.id,
    allowEager: config.allowEager,
  });

  await client.setMyCommands(
    HELP.split("\n").map((line) => {
      const [command = "", ...rest] = line.split(" — ");
      return { command: command.replace(/^\//, "").split(" ")[0] ?? "", description: rest.join(" — ") };
    }),
  );

  console.log(`@${me.username ?? me.id} polling. eager mode ${config.allowEager ? "allowed" : "disabled"}.`);

  let running = true;
  const shutdown = (): void => {
    running = false;
    store.close();
    console.log("stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      for (const update of await client.getUpdates()) {
        // One bad update must not take down the poll loop for every chat.
        await handlers.handle(update).catch((e: unknown) => console.error("handler:", String(e)));
      }
    } catch (error) {
      console.error("poll:", String(error));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? String(error.message) : error);
  process.exit(1);
});
