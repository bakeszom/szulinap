import { APIError } from "@sumup/sdk";
import { cfg, ConfigError, requireBridge, requireSumUp } from "./config.js";
import { counterLoop } from "./counter.js";
import { refreshLoop, startHttp } from "./http.js";
import { errText, log } from "./logger.js";
import { sb } from "./supabase.js";
import { createSumUpClient, SumUpProvider } from "./sumup/SumUpProvider.js";
import { sleep, Worker } from "./worker.js";

/**
 * Szülinapi gyűjtőszolgáltatás.
 *   npm start                  szolgáltatás: sor → SumUp terminál → befizetés; szelfigép-számláló; kezelőoldal
 *   npm run pair -- <KÓD>      Solo / Virtual Solo párosítása (a kódot a terminál / virtual-solo.sumup.com adja)
 *   npm run readers            a SumUp-fiók readerei
 *   npm run status             reader-állapot + a gyűjtés állása
 *   npm run terminate          a terminálon függő fizetés megszakítása
 *   npm run reset -- --igen    MINDEN befizetés, kérés és számláló törlése (a buli előtti tesztek után)
 */
const [cmd = "start", ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (cmd) {
    case "start":
      return start();
    case "pair":
      return pair(args[0], args.slice(1).join(" "));
    case "readers": {
      requireSumUp(false);
      const client = createSumUpClient(cfg.sumup);
      const list = await client.readers.list(cfg.sumup.merchantCode);
      for (const r of list.items) console.log(`${r.id}  ${r.status.padEnd(10)} ${r.name}  (${r.device?.model ?? "?"})`);
      return;
    }
    case "status": {
      requireSumUp(true);
      const provider = new SumUpProvider(cfg.sumup, createSumUpClient(cfg.sumup), log);
      console.log("Reader:", await provider.getDeviceStatus());
      console.log("Gyűjtés:", await sb.feed());
      return;
    }
    case "terminate": {
      requireSumUp(true);
      const provider = new SumUpProvider(cfg.sumup, createSumUpClient(cfg.sumup), log);
      await provider.cancelCheckout({ paymentId: "cli", createdAt: new Date() });
      console.log("Terminate elküldve.");
      return;
    }
    case "reset": {
      requireBridge();
      if (!args.includes("--igen")) {
        console.log("Ez MINDEN befizetést, kérést és számlálót töröl a Supabase-ből. Futtasd így: npm run reset -- --igen");
        process.exitCode = 1;
        return;
      }
      await sb.reset();
      console.log("Törölve: befizetések, kérések, számlálók. A kivetítőn is nulláról indul (progress.html?live&reset).");
      return;
    }
    default:
      throw new ConfigError(`Ismeretlen parancs: ${cmd}`);
  }
}

async function pair(code: string | undefined, name: string): Promise<void> {
  if (!code) throw new ConfigError("Használat: npm run pair -- <PÁROSÍTÓKÓD> [név]");
  requireSumUp(false);
  const client = createSumUpClient(cfg.sumup);
  const reader = await client.readers.create(cfg.sumup.merchantCode, {
    pairing_code: code.trim().toUpperCase(),
    name: name || "Szulinap gyujtes",
  });
  console.log(`Reader létrehozva: ${reader.id} (status: ${reader.status}); várakozás a párosításra…`);
  for (let i = 0; i < 60 && reader.status !== "paired"; i++) {
    await sleep(2000);
    // snapify-pay megfigyelés: közvetlenül a create után a GET /readers/{id} átmenetileg 404-et adhat.
    const r = await client.readers.get(cfg.sumup.merchantCode, reader.id).catch(async (err: unknown) => {
      if (!(err instanceof APIError && err.status === 404)) throw err;
      const listed = (await client.readers.list(cfg.sumup.merchantCode)).items.find((x) => x.id === reader.id);
      if (!listed) throw err;
      return listed;
    });
    reader.status = r.status;
    if (r.status === "expired") break;
  }
  if (reader.status === "paired") console.log(`\nKész. Írd be a .env-be:\nSUMUP_READER_ID=${reader.id}`);
  else {
    process.exitCode = 1;
    console.log("A párosítás nem fejeződött be (a kód 5 percig érvényes; kezdd újra).");
  }
}

async function start(): Promise<void> {
  requireBridge();
  requireSumUp(true);
  const provider = new SumUpProvider(cfg.sumup, createSumUpClient(cfg.sumup), log);
  let sandbox: boolean | null = null;
  // Az init a snapify-pay szabálya szerint nem engedi az éles fiókot SUMUP_ALLOW_LIVE=true nélkül.
  await provider.init();
  try {
    const m = await createSumUpClient(cfg.sumup).merchants.get(cfg.sumup.merchantCode);
    sandbox = m.sandbox === true;
  } catch {
    /* csak kijelzéshez */
  }
  log.info({ sandbox, readerId: cfg.sumup.readerId }, sandbox ? "SumUp SANDBOX (tesztpénz)" : "SumUp ÉLES fiók");

  // A Supabase elérhető, és jó-e a titok? (rossz titoknál itt áll meg, nem a buli közben)
  await sb.feed();
  await sb.setCounter("bridge_started", Math.floor(Date.now() / 1000));

  const worker = new Worker(provider);
  let stopping = false;
  const isStopping = () => stopping;
  const shutdown = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    worker.stop();
    log.info(`${sig}: leállás (a terminálon lévő fizetést megszakítom)…`);
    setTimeout(() => process.exit(0), (cfg.payment.cancelMaxWaitS + 5) * 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));

  // A kezelőoldal és a számláló rögtön indul; a félbemaradt fizetés lezárása (recover) akár 2 percig is tarthat.
  startHttp(worker, () => sandbox);
  void refreshLoop(provider, isStopping);
  void counterLoop(isStopping);
  await worker.recover();
  log.info("Gyűjtés elindult: várom a kéréseket (buliapp / kezelőoldal)");
  await worker.loop();
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(`Beállítási hiba: ${err.message}`);
  else console.error(`Hiba: ${errText(err)}`);
  process.exit(1);
});
