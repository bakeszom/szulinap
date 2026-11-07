import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";
import { errText, log } from "./logger.js";
import { sb } from "./supabase.js";
import { sleep } from "./worker.js";

/**
 * Szelfigép-számláló: a snapify API operátori élő nézetéből (GET /admin/events/<slug>/live)
 * kiolvassa, hány lapot nyomtatott a gép az eseményen (`quota.used`), és a Supabase `counters`
 * táblájába írja ('photos'). A kivetítő (progress.html) innen mutatja.
 *
 * Belépés: SNAPIFY_TOKEN (az admin felület tokenje), vagy SNAPIFY_EMAIL + SNAPIFY_PASSWORD
 * (ilyenkor 30 napos tokent kér, és a data/snapify-token.txt-be teszi).
 */
const tokenFile = () => path.join(cfg.dataDir, "snapify-token.txt");

export const counterState = {
  enabled: false,
  photos: null as number | null,
  lastOkAt: null as string | null,
  lastError: null as string | null,
  eventName: null as string | null,
  printerOnline: null as boolean | null,
};

let token = "";

function loadToken(): string {
  if (cfg.snapify.token) return cfg.snapify.token;
  try {
    return fs.readFileSync(tokenFile(), "utf8").trim();
  } catch {
    return "";
  }
}

async function login(): Promise<string> {
  if (!cfg.snapify.email || !cfg.snapify.password) {
    throw new Error("A snapify token lejárt vagy hiányzik; adj meg SNAPIFY_EMAIL + SNAPIFY_PASSWORD-öt vagy új SNAPIFY_TOKEN-t");
  }
  const res = await fetch(`${cfg.snapify.apiUrl}/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cfg.snapify.email, password: cfg.snapify.password, remember: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: { token?: string }; error?: { message?: string } };
  if (!res.ok || !j.data?.token) throw new Error(`snapify belépés sikertelen (${res.status}): ${j.error?.message ?? ""}`);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(tokenFile(), j.data.token);
  log.info("snapify: bejelentkezve (30 napos token elmentve)");
  return j.data.token;
}

interface LiveSnapshot {
  event: { name: string; quota: { used: number; reserved: number } };
  printer?: { online?: boolean };
}

async function fetchLive(): Promise<LiveSnapshot> {
  if (!token) token = loadToken() || (await login());
  const url = `${cfg.snapify.apiUrl}/admin/events/${encodeURIComponent(cfg.snapify.eventSlug)}/live`;
  const get = () => fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  let res = await get();
  if (res.status === 401) {
    token = await login();
    res = await get();
  }
  const j = (await res.json().catch(() => ({}))) as { data?: LiveSnapshot; error?: { message?: string } };
  if (!res.ok || !j.data) throw new Error(`snapify ${res.status}: ${j.error?.message ?? "ismeretlen hiba"}`);
  return j.data;
}

export async function counterLoop(isStopping: () => boolean): Promise<void> {
  if (!cfg.snapify.eventSlug) {
    log.warn("Nincs SNAPIFY_EVENT_SLUG: a szelfigép-számláló ki van kapcsolva");
    return;
  }
  counterState.enabled = true;
  let pushed: number | null = null;
  let pushedAt = 0;
  let lastLoggedError = "";
  while (!isStopping()) {
    try {
      const live = await fetchLive();
      const used = Number(live.event.quota?.used ?? 0);
      counterState.eventName = live.event.name;
      counterState.printerOnline = live.printer?.online ?? null;
      counterState.photos = used;
      counterState.lastOkAt = new Date().toISOString();
      counterState.lastError = null;
      lastLoggedError = "";
      // Változáskor azonnal, egyébként percenként újraírjuk (egy `npm run reset` után is helyreáll).
      if (used !== pushed || Date.now() - pushedAt > 60_000) {
        await sb.setCounter("photos", used);
        if (pushed !== null && used !== pushed) log.info({ photos: used }, "Szelfigép: új nyomat");
        else if (pushed === null) log.info({ photos: used, event: live.event.name }, "Szelfigép-számláló elindult");
        pushed = used;
        pushedAt = Date.now();
      }
    } catch (err) {
      counterState.lastError = errText(err);
      if (counterState.lastError !== lastLoggedError) {
        log.warn({ err: counterState.lastError }, "Szelfigép-számláló: hiba");
        lastLoggedError = counterState.lastError;
      }
    }
    await sleep(cfg.snapify.pollS * 1000);
  }
}
