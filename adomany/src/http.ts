import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cfg } from "./config.js";
import { counterState } from "./counter.js";
import { errText, log } from "./logger.js";
import { sb, SupabaseError, type DonationRequest, type ProgressFeed } from "./supabase.js";
import type { DeviceStatus, PaymentProvider } from "./sumup/types.js";
import { sleep, type Worker } from "./worker.js";

/**
 * Helyi kezelőoldal a gyűjtőgépen (alapból csak 127.0.0.1): összeg küldése a terminálra azoknak,
 * akik nem a buliappból szállnak be, a sor és az állapot figyelése, készpénz kézi rögzítése.
 */
const kioskHtml = () => fs.readFileSync(fileURLToPath(new URL("./kiosk.html", import.meta.url)), "utf8");

const snapshot = {
  feed: null as ProgressFeed | null,
  open: [] as DonationRequest[],
  recent: [] as DonationRequest[],
  reader: null as DeviceStatus | null,
  readerError: null as string | null,
  supabaseError: null as string | null,
};

/** Háttérfrissítés: a felület 1 mp-enként kérdez, de a külső szolgáltatásokat ritkábban hívjuk. */
export async function refreshLoop(provider: PaymentProvider, isStopping: () => boolean): Promise<void> {
  let lastReader = 0;
  while (!isStopping()) {
    try {
      const [feed, open, recent] = await Promise.all([sb.feed(), sb.listOpen(), sb.recent(12)]);
      Object.assign(snapshot, { feed, open, recent, supabaseError: null });
    } catch (err) {
      snapshot.supabaseError = errText(err);
    }
    if (Date.now() - lastReader > 15_000) {
      lastReader = Date.now();
      try {
        snapshot.reader = (await provider.getDeviceStatus()) ?? null;
        snapshot.readerError = null;
      } catch (err) {
        snapshot.readerError = errText(err);
      }
    }
    await sleep(2000);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Túl nagy kérés");
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function parseAmount(v: unknown): number {
  const n = Math.round(Number(String(v ?? "").replace(/[^\d]/g, "")));
  if (!Number.isSafeInteger(n) || n < 500 || n > 500_000) throw new Error("Az összeg 500 és 500 000 Ft között lehet");
  return n;
}
const parseName = (v: unknown) => String(v ?? "").trim().slice(0, 40) || "Valaki";

export function startHttp(worker: Worker, sandbox: () => boolean | null): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(kioskHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const cur = worker.current;
        send(res, 200, {
          now: new Date().toISOString(),
          sandbox: sandbox(),
          maxWaitS: cfg.payment.checkoutMaxWaitS,
          current: cur && {
            id: cur.request.id,
            name: cur.request.name,
            amount: cur.request.amount,
            source: cur.request.source,
            phase: cur.phase,
            info: cur.info,
            elapsedS: Math.round((Date.now() - cur.startedAt) / 1000),
          },
          feed: snapshot.feed,
          open: snapshot.open,
          recent: snapshot.recent,
          reader: snapshot.reader,
          readerError: snapshot.readerError,
          supabaseError: snapshot.supabaseError,
          unsynced: worker.unsynced.length,
          lastError: worker.lastError,
          counter: counterState,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/request") {
        const body = await readJson(req);
        const row = await sb.insertRequest({ name: parseName(body.name), amount: parseAmount(body.amount), source: "kiosk" });
        log.info({ requestId: row.id, amount: row.amount, name: row.name }, "Kezelőoldal: új kérés a sorba");
        send(res, 200, { ok: true, request: row });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/cancel") {
        const body = await readJson(req);
        const status = await sb.cancelRequest(Number(body.id));
        send(res, 200, { ok: true, status });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/cash") {
        const body = await readJson(req);
        const amount = Math.round(Number(String(body.amount ?? "").replace(/[^\d]/g, "")));
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_000_000) throw new Error("Hibás összeg");
        const name = parseName(body.name);
        await worker.record({ requestId: null, txCode: `kp-${randomUUID()}`, name, amount, at: new Date().toISOString() });
        log.info({ amount, name }, "Kezelőoldal: készpénz rögzítve");
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { ok: false, error: "Nincs ilyen végpont" });
    } catch (err) {
      const msg =
        err instanceof SupabaseError && err.code === "23514"
          ? "Az összeg 500 és 500 000 Ft között lehet"
          : errText(err);
      send(res, 400, { ok: false, error: msg });
    }
  });
  server.listen(cfg.http.port, cfg.http.host, () => {
    log.info(`Kezelőoldal: http://${cfg.http.host === "0.0.0.0" ? "localhost" : cfg.http.host}:${cfg.http.port}/`);
  });
  return server;
}
