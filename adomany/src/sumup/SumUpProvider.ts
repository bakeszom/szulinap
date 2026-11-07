import SumUp, { SumUpError, type GetReaderCheckoutResponse, type TransactionFull } from "@sumup/sdk";
import type { SumUpConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { hufToSumUp } from "./money.js";
import {
  PaymentProviderError,
  type CheckoutHandle,
  type CheckoutRequest,
  type CheckoutState,
  type CheckoutStatus,
  type DeviceStatus,
  type PaymentProvider,
  type ReconciledPayment,
} from "./types.js";
import { mapSumUpError } from "./errors.js";

/** Az SDK-ból csak ennyit használunk; tesztben ezt mockoljuk. */
export type SumUpClient = Pick<SumUp, "readers" | "transactions" | "merchants">;

export function createSumUpClient(cfg: Pick<SumUpConfig, "apiKey" | "host" | "requestTimeoutMs">): SumUp {
  // maxRetries: 0 – a checkout-létrehozást SOHA nem ismételjük vakon (dupla terhelés veszélye);
  // az újrapróbálás és az egyeztetés a mi felelősségünk.
  return new SumUp({ apiKey: cfg.apiKey, host: cfg.host, timeout: cfg.requestTimeoutMs, maxRetries: 0 });
}

/**
 * SumUp Cloud API (Solo) fizetés.
 *
 * Végpontok (SDK 0.2.0):
 *  - POST /v0.1/merchants/{mc}/readers/{id}/checkout          readers.createCheckout
 *  - GET  /v0.1/merchants/{mc}/readers/{id}/checkout/{cid}    readers.getCheckout
 *  - POST /v0.1/merchants/{mc}/readers/{id}/terminate         readers.terminateCheckout
 *  - GET  /v0.1/merchants/{mc}/readers/{id}/status            readers.getStatus
 *  - GET  /v2.1/merchants/{mc}/transactions?...               transactions.get
 */
/** Ennyit várunk a hiányzó payment_failure_reason-re egy lezárt checkoutnál. */
const REASON_GRACE_MS = 3000;

export class SumUpProvider implements PaymentProvider {
  readonly name = "sumup";
  private readonly reasonWaitSince = new Map<string, number>();

  constructor(
    private readonly cfg: SumUpConfig,
    private readonly client: SumUpClient,
    private readonly log: Logger,
  ) {}

  private get readerId(): string {
    if (!this.cfg.readerId) {
      throw new PaymentProviderError("READER_NOT_PAIRED", "Nincs SUMUP_READER_ID: előbb párosítsd a readert (npm run pair).");
    }
    return this.cfg.readerId;
  }

  async init(): Promise<void> {
    const merchant = await this.call(() => this.client.merchants.get(this.cfg.merchantCode));
    const sandbox = merchant.sandbox === true;
    this.log.info({ merchantCode: this.cfg.merchantCode, sandbox }, "SumUp fiók elérhető");
    if (!sandbox && !this.cfg.allowLive) {
      throw new PaymentProviderError(
        "LIVE_ACCOUNT_BLOCKED",
        "A SumUp fiók NEM sandbox. Valódi pénzzel nem tesztelünk: élesítéshez állítsd be a SUMUP_ALLOW_LIVE=true-t.",
      );
    }

    const reader = await this.call(() => this.client.readers.get(this.cfg.merchantCode, this.readerId));
    this.log.info(
      { readerId: reader.id, name: reader.name, status: reader.status, device: reader.device },
      "SumUp reader",
    );
    if (reader.status !== "paired") {
      throw new PaymentProviderError("READER_NOT_PAIRED", `A reader állapota: ${reader.status} (paired kellene).`);
    }
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutHandle> {
    const body = {
      total_amount: hufToSumUp(req.amountHuf),
      description: req.description,
      affiliate: {
        app_id: this.cfg.affiliateAppId,
        key: this.cfg.affiliateKey,
        // A saját azonosítónk: ezzel a Transactions API-ban akkor is visszakereshető
        // a fizetés, ha a create válasza elveszett (timeout, hálózati hiba).
        foreign_transaction_id: req.paymentId,
      },
      ...(this.cfg.returnUrl ? { return_url: this.cfg.returnUrl } : {}),
    };
    const res = await this.call(
      () => this.client.readers.createCheckout(this.cfg.merchantCode, this.readerId, body),
      { isCreate: true },
    );
    return {
      paymentId: req.paymentId,
      checkoutId: res.data.checkout_id,
      clientTransactionId: res.data.client_transaction_id,
      createdAt: new Date(),
    };
  }

  async getCheckoutStatus(handle: CheckoutHandle): Promise<CheckoutStatus> {
    if (handle.checkoutId) {
      const res = await this.call(() =>
        this.client.readers.getCheckout(this.cfg.merchantCode, this.readerId, handle.checkoutId!),
      );
      const d = res.data;
      // Sandbox-megfigyelés (2026-10-20): a "failed"/"cancelled" státusz ~1 s-mal előbb jön,
      // mint a payment_failure_reason. Az indok nélkül a vendég Cancel-je elutasításnak
      // látszana, ezért rövid ideig még függőnek vesszük.
      if ((d.status === "failed" || d.status === "cancelled") && !d.payment_failure_reason) {
        const first = this.reasonWaitSince.get(handle.checkoutId) ?? Date.now();
        this.reasonWaitSince.set(handle.checkoutId, first);
        if (Date.now() - first < REASON_GRACE_MS) {
          return { state: "pending", providerStatus: `${d.status}_awaiting_reason`, raw: mapReaderCheckout(d).raw };
        }
      }
      this.reasonWaitSince.delete(handle.checkoutId);
      const status = mapReaderCheckout(d);
      if (status.state === "successful" && handle.clientTransactionId) {
        await this.attachTransaction(status, { client_transaction_id: handle.clientTransactionId });
      }
      if (status.state === "expired") return this.verifyExpired(handle, status);
      return status;
    }
    // A createCheckout válaszában a checkout_id opcionális: ilyenkor a Transactions API marad.
    const rec = await this.reconcile(handle.paymentId, handle);
    return {
      state: rec.state ?? "pending",
      providerStatus: rec.providerStatus ?? "NOT_FOUND",
      transactionId: rec.transactionId,
      transactionCode: rec.transactionCode,
    };
  }

  async cancelCheckout(_handle: CheckoutHandle): Promise<void> {
    // A terminate a reader aktuális tranzakcióját állítja le (nem checkout-azonosító alapján).
    // Aszinkron, nincs visszaigazolása, és csak akkor hat, ha a reader a kártyabirtokosra vár.
    try {
      await this.client.readers.terminateCheckout(this.cfg.merchantCode, this.readerId, {});
    } catch (err) {
      // A válasz 202, a spec szerint application/json, de séma nélkül. Az SDK 0.2.0 csak
      // "content-length: 0" esetén hagyja ki a JSON-parse-t; üres chunked törzsre
      // SyntaxError-t dob, pedig a kérés sikerült (nem 2xx esetén APIError jönne).
      if (err instanceof SyntaxError || (err instanceof SumUpError && /non-json/i.test(err.message))) return;
      throw mapSumUpError(err);
    }
  }

  async getDeviceStatus(): Promise<DeviceStatus | undefined> {
    const res = await this.call(() => this.client.readers.getStatus(this.cfg.merchantCode, this.readerId));
    const d = res.data;
    return {
      online: d.status === "ONLINE",
      state: d.state,
      batteryLevel: d.battery_level,
      connectionType: d.connection_type,
      firmwareVersion: d.firmware_version,
      lastActivity: d.last_activity,
    };
  }

  async reconcile(paymentId: string, handle?: CheckoutHandle): Promise<ReconciledPayment> {
    const queries = [
      handle?.clientTransactionId ? { client_transaction_id: handle.clientTransactionId } : undefined,
      { foreign_transaction_id: paymentId },
    ].filter((q): q is NonNullable<typeof q> => q !== undefined);

    for (const query of queries) {
      try {
        const tx = await this.call(() => this.client.transactions.get(this.cfg.merchantCode, query));
        return {
          found: true,
          state: mapTransactionStatus(tx.status),
          providerStatus: tx.status,
          transactionId: tx.id,
          transactionCode: tx.transaction_code,
          amountHuf: tx.amount,
          paidAt: tx.timestamp ? new Date(tx.timestamp) : undefined,
        };
      } catch (err) {
        if (err instanceof PaymentProviderError && err.code === "NOT_FOUND") continue;
        throw err;
      }
    }
    return { found: false };
  }

  /**
   * Sandbox-mérés (2026-10-20, longlife + latepay-probe): a magára hagyott checkout ~270 s
   * után `expired` lesz, de a reader kijelzőjén MEGMARAD, és még kifizethető. Ilyenkor a
   * tranzakció SUCCESSFUL, a get-checkout viszont végig `expired`. Ezért a lejáratot csak
   * a Transactions API-val együtt fogadjuk el: sikeres tranzakció → sikeres fizetés (jár a
   * session); függő tranzakció → még függő (a vendég épp fizet); nincs / sikertelen → lejárt.
   */
  private async verifyExpired(handle: CheckoutHandle, status: CheckoutStatus): Promise<CheckoutStatus> {
    const rec = await this.reconcile(handle.paymentId, handle);
    if (!rec.found || rec.state === "failed" || rec.state === "cancelled") return status;
    if (rec.state === "successful") {
      this.log.warn(
        { paymentId: handle.paymentId, transactionCode: rec.transactionCode },
        "A checkout lejártnak látszik, de a tranzakció SIKERES (a vendég a lejárt checkoutot fizette ki)",
      );
      return {
        ...status,
        state: "successful",
        providerStatus: `expired_tx_${rec.providerStatus ?? "SUCCESSFUL"}`,
        transactionId: rec.transactionId,
        transactionCode: rec.transactionCode,
        paidAt: rec.paidAt,
      };
    }
    return { ...status, state: "pending", providerStatus: `expired_tx_${rec.providerStatus ?? "PENDING"}` };
  }

  private async attachTransaction(status: CheckoutStatus, query: { client_transaction_id: string }): Promise<void> {
    try {
      const tx: TransactionFull = await this.call(() => this.client.transactions.get(this.cfg.merchantCode, query));
      status.transactionId = tx.id;
      status.transactionCode = tx.transaction_code;
    } catch (err) {
      // Nem kritikus: a fizetés sikeres, a tranzakció-azonosító később is pótolható.
      this.log.warn({ err: mapSumUpError(err).message }, "Tranzakció-azonosító lekérése sikertelen");
    }
  }

  private async call<T>(fn: () => Promise<T>, opts: { isCreate?: boolean } = {}): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapSumUpError(err, opts);
    }
  }
}

type ReaderCheckoutData = GetReaderCheckoutResponse["data"];

export function mapReaderCheckout(d: ReaderCheckoutData): CheckoutStatus {
  const state = classifyReaderCheckout(d);
  return {
    state,
    paidAt: state === "successful" && d.updated_at ? new Date(d.updated_at) : undefined,
    providerStatus: d.status,
    failureReason: d.payment_failure_reason ?? undefined,
    validUntil: d.valid_until ? new Date(d.valid_until) : undefined,
    raw: {
      checkout_id: d.checkout_id,
      status: d.status,
      payment_status: d.payment_status,
      payment_failure_reason: d.payment_failure_reason,
      valid_until: d.valid_until,
      created_at: d.created_at,
      updated_at: d.updated_at,
      reader_firmware_version: d.reader_firmware_version,
    },
  };
}

function classifyReaderCheckout(d: ReaderCheckoutData): CheckoutState {
  // Az SDK 0.2.0 típusa csak pending|successful|failed|cancelled, de a valódi API
  // "expired"-et is ad (sandbox, 2026-10-20: a magára hagyott checkout ~270 s után).
  switch (d.status as ReaderCheckoutData["status"] | "expired") {
    case "expired":
      // A SumUpProvider.verifyExpired még a Transactions API-val ellenőrzi (kifizethető maradhat!).
      return "expired";
    case "pending":
      return "pending";
    case "successful":
      return "successful";
    case "failed":
      // Sandbox-megfigyelés (2026-10-20): a vendég Cancel-gombja "failed" státuszt ad
      // "CANCELLED: Transaction cancelled by cancel button on reader …" indokkal. Ez nem elutasítás.
      return /^CANCELLED/i.test(d.payment_failure_reason ?? "") ? "cancelled" : "failed";
    case "cancelled":
      // A valid_until NEM megbízható lejárat-jelző: sandboxban (Virtual Solo, 2026-10-20)
      // a checkout a valid_until után is "pending" maradt és ki is lehetett fizetni.
      // Lejáratnak csak azt vesszük, amit a szolgáltató indoklása annak mond.
      return /expir|time.?out|timed out/i.test(d.payment_failure_reason ?? "") ? "expired" : "cancelled";
    default:
      // Ismeretlen új státusz: biztonságos alapértelmezés, tovább pollozunk.
      return "pending";
  }
}

export function mapTransactionStatus(s: TransactionFull["status"]): CheckoutState {
  switch (s) {
    case "SUCCESSFUL":
    case "REFUNDED":
      return "successful";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "PENDING":
    default:
      return "pending";
  }
}
