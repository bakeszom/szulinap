import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cfg } from "./config.js";
import { errText, log } from "./logger.js";
import { sb, type DonationRequest } from "./supabase.js";
import {
  FINAL_CHECKOUT_STATES,
  PaymentProviderError,
  type CheckoutHandle,
  type CheckoutStatus,
  type PaymentProvider,
} from "./sumup/types.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ami épp a terminálon van – a helyi oldal ezt mutatja. */
export interface Current {
  request: DonationRequest;
  phase: "sending" | "waiting_card" | "cancelling" | "finishing";
  startedAt: number;
  info: string;
}

/** A terminálon lévő checkout adatai, hogy újraindulás után folytatni tudjuk (data/inflight.json). */
interface Inflight {
  request: DonationRequest;
  handle: { paymentId: string; checkoutId?: string; clientTransactionId?: string; createdAt: string };
}

/** Rögzítésre váró befizetés (ha a Supabase épp nem elérhető, újrapróbáljuk). */
interface PendingRecord {
  requestId: number | null;
  txCode: string | null;
  name: string;
  amount: number;
  at: string;
}

const inflightFile = () => path.join(cfg.dataDir, "inflight.json");
const ledgerFile = () => path.join(cfg.dataDir, "befizetesek.jsonl");

function saveInflight(v: Inflight | null): void {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    if (v) fs.writeFileSync(inflightFile(), JSON.stringify(v, null, 2));
    else fs.rmSync(inflightFile(), { force: true });
  } catch (err) {
    log.warn({ err: errText(err) }, "inflight.json írása sikertelen");
  }
}

function loadInflight(): Inflight | null {
  try {
    return JSON.parse(fs.readFileSync(inflightFile(), "utf8")) as Inflight;
  } catch {
    return null;
  }
}

/** Minden sikeres befizetés ELŐBB ide kerül (helyi tartalék), csak utána a Supabase-be. */
function appendLedger(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.appendFileSync(ledgerFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    log.error({ err: errText(err) }, "A helyi befizetés-napló írása sikertelen");
  }
}

const fmt = (n: number) => `${n.toLocaleString("hu-HU")} Ft`;

export class Worker {
  current: Current | null = null;
  lastError: { at: string; text: string } | null = null;
  readonly unsynced: PendingRecord[] = [];
  private stopping = false;

  constructor(private readonly provider: PaymentProvider) {}

  stop(): void {
    this.stopping = true;
  }

  private setError(text: string): void {
    this.lastError = { at: new Date().toISOString(), text };
  }

  /** Indulás: a félbemaradt checkout folytatása, a gazdátlan 'sent' kérések lezárása. */
  async recover(): Promise<void> {
    const inflight = loadInflight();
    if (inflight) {
      log.warn({ requestId: inflight.request.id }, "Újraindulás egy terminálon lévő fizetés közben: folytatom a figyelését");
      const handle: CheckoutHandle = { ...inflight.handle, createdAt: new Date(inflight.handle.createdAt) };
      await this.watch(inflight.request, handle);
      this.current = null;
    } else {
      // Ha valami a terminálon ragadt (pl. egy korábbi futásból), megszakítjuk.
      await this.provider.cancelCheckout({ paymentId: "startup", createdAt: new Date() }).catch(() => undefined);
    }
    const open = await sb.listOpen();
    for (const r of open.filter((x) => x.status === "sent")) {
      await sb.updateRequest(r.id, "expired", "A gyűjtőgép újraindult, kérlek próbáld újra");
      log.warn({ requestId: r.id }, "Gazdátlan 'sent' kérés lezárva (újraindulás)");
    }
  }

  async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.flushUnsynced();
        await this.tick();
      } catch (err) {
        this.setError(errText(err));
        log.warn({ err: errText(err) }, "Sorfeldolgozás: hiba, újrapróbálom");
        await sleep(3000);
      }
      await sleep(cfg.payment.queuePollMs);
    }
  }

  private async tick(): Promise<void> {
    const open = await sb.listOpen();
    const now = Date.now();
    let next: DonationRequest | undefined;
    for (const r of open) {
      if (r.status !== "pending") continue;
      if (now - Date.parse(r.created_at) > cfg.payment.pendingMaxAgeS * 1000) {
        await sb.updateRequest(r.id, "expired", "Túl sokáig várt a sorban, kérlek küldd újra");
        log.info({ requestId: r.id }, "Sorban lejárt kérés");
        continue;
      }
      next ??= r;
    }
    if (next) await this.process(next);
  }

  /** Egy kérés a terminálra: checkout, várakozás a kártyára, eredmény rögzítése. */
  async process(req: DonationRequest): Promise<void> {
    this.current = { request: req, phase: "sending", startedAt: Date.now(), info: "Küldés a terminálra…" };
    log.info({ requestId: req.id, name: req.name, amount: req.amount, source: req.source }, `Új befizetés: ${fmt(req.amount)}`);
    try {
      await sb.updateRequest(req.id, "sent", "Küldés a terminálra…");
      const handle = await this.createCheckout(req);
      if (!handle) return;
      await sb.updateRequest(req.id, "sent", `Érintsd a kártyádat a terminálhoz: ${fmt(req.amount)}`).catch((err) =>
        log.warn({ err: errText(err) }, "Státusz frissítése sikertelen"),
      );
      await this.watch(req, handle);
    } finally {
      this.current = null;
    }
  }

  private async createCheckout(req: DonationRequest): Promise<CheckoutHandle | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const paymentId = `szulinap-${req.id}-${randomUUID().slice(0, 8)}`;
      try {
        const handle = await this.provider.createCheckout({
          paymentId,
          amountHuf: req.amount,
          description: cfg.payment.description,
        });
        saveInflight({ request: req, handle: { ...handle, createdAt: handle.createdAt.toISOString() } as Inflight["handle"] });
        log.info({ requestId: req.id, checkoutId: handle.checkoutId }, "Checkout a terminálon");
        return handle;
      } catch (err) {
        const e = err instanceof PaymentProviderError ? err : undefined;
        log.warn({ requestId: req.id, attempt, code: e?.code, err: errText(err) }, "Checkout létrehozása sikertelen");
        if (e?.ambiguous) {
          // A kérés eljuthatott a SumUp-hoz: megnézzük, létrejött-e (a saját azonosítónkkal).
          await sleep(3000);
          const rec = await this.provider.reconcile(paymentId).catch(() => ({ found: false }) as const);
          if (rec.found) {
            const handle: CheckoutHandle = { paymentId, createdAt: new Date() };
            saveInflight({ request: req, handle: { paymentId, createdAt: handle.createdAt.toISOString() } });
            return handle;
          }
          // Biztos, ami biztos: ami a terminálon lehet, azt leállítjuk, mielőtt újra küldenénk.
          await this.provider.cancelCheckout({ paymentId, createdAt: new Date() }).catch(() => undefined);
          await sleep(3000);
          continue;
        }
        if (e?.code === "READER_BUSY") {
          await this.provider.cancelCheckout({ paymentId, createdAt: new Date() }).catch(() => undefined);
          await sleep(4000);
          continue;
        }
        if (e?.retryable && attempt < 3) {
          await sleep(3000);
          continue;
        }
        const why =
          e?.code === "READER_OFFLINE"
            ? "A terminál nincs online"
            : e?.code === "AUTH"
              ? "SumUp-hitelesítési hiba"
              : "Nem sikerült a terminálra küldeni";
        this.setError(`${why}: ${errText(err)}`);
        await sb.updateRequest(req.id, "failed", `${why}. Szólj a szelfigépesnek!`);
        return null;
      }
    }
    await sb.updateRequest(req.id, "failed", "A terminál foglalt, kérlek próbáld újra");
    return null;
  }

  /** Pollozás a végeredményig; vendég-visszavonás és időkorlát esetén terminate. */
  private async watch(req: DonationRequest, handle: CheckoutHandle): Promise<void> {
    const t0 = Date.now();
    const maxWait = cfg.payment.checkoutMaxWaitS * 1000;
    let cancelAt: number | undefined;
    let cancelReason: "timeout" | "guest" | "shutdown" | undefined;
    let lastCancelCheck = 0;
    let final: CheckoutStatus | undefined;
    if (this.current) this.current.phase = "waiting_card";
    else this.current = { request: req, phase: "waiting_card", startedAt: t0, info: "" };
    this.current.info = `Érintsd a kártyát: ${fmt(req.amount)}`;

    for (;;) {
      const now = Date.now();
      if (cancelAt === undefined) {
        let reason: typeof cancelReason;
        if (now - t0 > maxWait) reason = "timeout";
        else if (this.stopping) reason = "shutdown";
        else if (now - lastCancelCheck > 2000) {
          lastCancelCheck = now;
          const fresh = await sb.get(req.id).catch(() => undefined);
          if (fresh?.cancel_requested) reason = "guest";
        }
        if (reason) {
          cancelAt = now;
          cancelReason = reason;
          this.current.phase = "cancelling";
          this.current.info = "Megszakítás…";
          log.info({ requestId: req.id, reason }, "Checkout megszakítása");
          await this.provider.cancelCheckout(handle).catch((err) => log.warn({ err: errText(err) }, "Terminate sikertelen"));
        }
      }
      if (cancelAt !== undefined && now - cancelAt > cfg.payment.cancelMaxWaitS * 1000) break;

      try {
        const st = await this.provider.getCheckoutStatus(handle);
        if (FINAL_CHECKOUT_STATES.has(st.state)) {
          final = st;
          break;
        }
      } catch (err) {
        log.warn({ requestId: req.id, err: errText(err) }, "Állapotlekérdezés sikertelen");
      }
      await sleep(cfg.payment.pollIntervalMs);
    }

    // Megszakítás után is lehet, hogy épp kifizették: a tranzakciólista dönt.
    if (!final || final.state === "expired") {
      const rec = await this.provider.reconcile(handle.paymentId, handle).catch(() => undefined);
      if (rec?.found && rec.state === "successful") {
        final = { state: "successful", providerStatus: rec.providerStatus ?? "SUCCESSFUL", transactionCode: rec.transactionCode };
      }
    }

    this.current.phase = "finishing";
    const state = final?.state ?? "expired";
    if (state === "successful") {
      const txCode = final?.transactionCode ?? final?.transactionId ?? handle.clientTransactionId ?? handle.paymentId;
      log.info({ requestId: req.id, txCode, amount: req.amount, name: req.name }, `SIKERES befizetés: ${fmt(req.amount)} · ${req.name}`);
      await this.record({ requestId: req.id, txCode, name: req.name, amount: req.amount, at: new Date().toISOString() });
    } else if (state === "failed") {
      log.info({ requestId: req.id, reason: final?.failureReason }, "Elutasított fizetés");
      await this.safeUpdate(req.id, "failed", "A kártyát elutasították. Próbáld újra, vagy egy másik kártyával.");
    } else if (state === "cancelled") {
      const info = cancelReason === "guest" ? "Visszavonva" : cancelReason === "timeout" ? "Lejárt: nem érkezett kártya" : "Megszakítva a terminálon";
      log.info({ requestId: req.id, cancelReason }, "Megszakított fizetés");
      await this.safeUpdate(req.id, cancelReason === "timeout" ? "expired" : "cancelled", info);
    } else {
      log.info({ requestId: req.id, cancelReason }, "Lejárt fizetés");
      await this.safeUpdate(
        req.id,
        cancelReason === "guest" ? "cancelled" : "expired",
        cancelReason === "guest" ? "Visszavonva" : `Lejárt: ${cfg.payment.checkoutMaxWaitS} mp alatt nem érkezett kártya`,
      );
    }
    saveInflight(null);
  }

  private async safeUpdate(id: number, status: "failed" | "cancelled" | "expired", info: string): Promise<void> {
    for (let i = 0; i < 5; i++) {
      try {
        await sb.updateRequest(id, status, info);
        return;
      } catch (err) {
        log.warn({ err: errText(err) }, "Státusz írása sikertelen, újrapróbálom");
        await sleep(2000);
      }
    }
  }

  /** Befizetés rögzítése: helyi napló + Supabase (sikertelenség esetén a háttérben újrapróbálva). */
  async record(r: PendingRecord): Promise<void> {
    appendLedger({ type: "befizetes", ...r });
    try {
      await sb.addDonation(r.requestId, r.txCode, r.name, r.amount);
    } catch (err) {
      this.setError(`Befizetés rögzítése a Supabase-ben sikertelen: ${errText(err)}`);
      log.error({ err: errText(err), ...r }, "A befizetés NINCS még a Supabase-ben, újrapróbálom");
      this.unsynced.push(r);
    }
  }

  private async flushUnsynced(): Promise<void> {
    while (this.unsynced.length) {
      const r = this.unsynced[0]!;
      await sb.addDonation(r.requestId, r.txCode, r.name, r.amount);
      this.unsynced.shift();
      log.info({ requestId: r.requestId, txCode: r.txCode }, "Késve rögzített befizetés a Supabase-ben");
    }
  }
}
