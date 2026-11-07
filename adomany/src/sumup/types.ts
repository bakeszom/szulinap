/**
 * Fizetési szolgáltató absztrakció. Az első implementáció a SumUp Cloud API
 * (Solo), később cserélhető (myPOS, Stripe Terminal).
 *
 * Az állapotgép csak ezt az interfészt látja. A kimenet lekérdezése
 * pollinggal megy (`getCheckoutStatus`); egy webhookos szolgáltató ugyanezt
 * a metódust a beérkezett webhookokból tölti.
 */

export type CheckoutState =
  /** Elfogadva, a vendég még nem fizetett. */
  | "pending"
  /** Sikeres fizetés: jár a fotó. */
  | "successful"
  /** A kártyát elutasították / a fizetés hibával zárult. */
  | "failed"
  /** Megszakítva (vendég a readeren, vagy mi a terminate-tel). */
  | "cancelled"
  /** Lejárt anélkül, hogy bárki fizetett volna. */
  | "expired";

export const FINAL_CHECKOUT_STATES: ReadonlySet<CheckoutState> = new Set([
  "successful",
  "failed",
  "cancelled",
  "expired",
]);

export interface CheckoutRequest {
  /** A saját azonosítónk (UUID); SumUp-nál `foreign_transaction_id`. */
  paymentId: string;
  amountHuf: number;
  description: string;
}

export interface CheckoutHandle {
  paymentId: string;
  /** A szolgáltató checkout-azonosítója (SumUp: checkout_id). */
  checkoutId?: string | undefined;
  /** SumUp: client_transaction_id – ezzel kereshető a Transactions API-ban. */
  clientTransactionId?: string | undefined;
  createdAt: Date;
}

export interface CheckoutStatus {
  state: CheckoutState;
  /** A szolgáltató nyers státusza, naplózáshoz. */
  providerStatus: string;
  failureReason?: string | undefined;
  /** Meddig érvényes a checkout a szolgáltató szerint. */
  validUntil?: Date | undefined;
  /** Tranzakció azonosító (ha már van), számlázáshoz és visszatérítéshez. */
  transactionId?: string | undefined;
  transactionCode?: string | undefined;
  /** Mikor fizettek (a szolgáltató szerint); a pótló session ablakához. */
  paidAt?: Date | undefined;
  raw?: unknown;
}

export interface DeviceStatus {
  online: boolean;
  /** Pl. IDLE, WAITING_FOR_CARD, WAITING_FOR_PIN, UPDATING_FIRMWARE. */
  state?: string | undefined;
  batteryLevel?: number | undefined;
  connectionType?: string | undefined;
  firmwareVersion?: string | undefined;
  lastActivity?: string | undefined;
}

/** A tranzakció-API-ból egyeztetett végső eredmény (újraindulás utáni visszakereséshez). */
export interface ReconciledPayment {
  found: boolean;
  state?: CheckoutState | undefined;
  providerStatus?: string | undefined;
  transactionId?: string | undefined;
  transactionCode?: string | undefined;
  amountHuf?: number | undefined;
  /** A tranzakció ideje (Transactions API `timestamp`). */
  paidAt?: Date | undefined;
}

export interface PaymentProvider {
  readonly name: string;
  /** Hitelesítés, reader ellenőrzése. Hibát dob, ha nem lehet fizetést indítani. */
  init(): Promise<void>;
  createCheckout(req: CheckoutRequest): Promise<CheckoutHandle>;
  getCheckoutStatus(handle: CheckoutHandle): Promise<CheckoutStatus>;
  /**
   * Függő checkout megszakítása. Aszinkron: a végeredményt pollinggal kell
   * megvárni, és akár "successful" is lehet (ha a vendég épp fizetett).
   */
  cancelCheckout(handle: CheckoutHandle): Promise<void>;
  getDeviceStatus(): Promise<DeviceStatus | undefined>;
  /** Visszakeresés a saját azonosítónk alapján (pl. ha a create válasza elveszett). */
  reconcile(paymentId: string, handle?: CheckoutHandle): Promise<ReconciledPayment>;
}

export type PaymentErrorCode =
  | "AUTH"
  | "READER_BUSY"
  | "READER_OFFLINE"
  | "READER_NOT_PAIRED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_REQUEST"
  | "NETWORK"
  | "TIMEOUT"
  | "SERVER"
  | "UNSUPPORTED"
  | "LIVE_ACCOUNT_BLOCKED"
  | "UNKNOWN";

export class PaymentProviderError extends Error {
  override readonly name = "PaymentProviderError";
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    readonly opts: {
      status?: number | undefined;
      /** Érdemes-e ugyanazt újrapróbálni. */
      retryable?: boolean;
      /**
       * A kérés eljuthatott a szolgáltatóhoz (pl. timeout POST közben):
       * a checkout létrejöhetett, egyeztetni kell.
       */
      ambiguous?: boolean;
      detail?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
  }
  get status() {
    return this.opts.status;
  }
  get retryable() {
    return this.opts.retryable ?? false;
  }
  get ambiguous() {
    return this.opts.ambiguous ?? false;
  }
  get detail() {
    return this.opts.detail;
  }
}
