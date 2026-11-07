import { config as loadDotenv } from "dotenv";
import path from "node:path";

loadDotenv({ quiet: true });

/** A snapify-pay SumUpProvider ezt a típust várja (ugyanazok a mezők). */
export interface SumUpConfig {
  apiKey: string;
  merchantCode: string;
  readerId?: string | undefined;
  affiliateAppId: string;
  affiliateKey: string;
  host: string;
  requestTimeoutMs: number;
  returnUrl?: string | undefined;
  allowLive: boolean;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const env = process.env;
const str = (k: string, d = ""): string => (env[k] ?? d).replace(/\s+#.*$/, "").trim();
const num = (k: string, d: number): number => {
  const v = str(k);
  if (!v) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`${k}: nem szám (${v})`);
  return n;
};
const bool = (k: string, d = false): boolean => {
  const v = str(k).toLowerCase();
  return v ? v === "true" || v === "1" || v === "igen" : d;
};

export const cfg = {
  supabase: {
    url: str("SUPABASE_URL", "https://nrxalvrmupcgorkzobru.supabase.co"),
    // Nyilvános (publishable) kulcs, ugyanaz, mint a buliappban. Az írást a BRIDGE_SECRET védi.
    key: str("SUPABASE_KEY", "sb_publishable_8LW2yc9cSgSqFTMn0qim3w_w0iurlcI"),
    bridgeSecret: str("BRIDGE_SECRET"),
  },
  sumup: {
    apiKey: str("SUMUP_API_KEY"),
    merchantCode: str("SUMUP_MERCHANT_CODE"),
    readerId: str("SUMUP_READER_ID") || undefined,
    affiliateAppId: str("SUMUP_AFFILIATE_APP_ID"),
    affiliateKey: str("SUMUP_AFFILIATE_KEY"),
    host: str("SUMUP_API_HOST", "https://api.sumup.com"),
    requestTimeoutMs: num("SUMUP_REQUEST_TIMEOUT_MS", 15000),
    allowLive: bool("SUMUP_ALLOW_LIVE"),
  } satisfies SumUpConfig,
  payment: {
    description: str("PAYMENT_DESCRIPTION", "Ádám esküvőjére"),
    /** Ennyi ideig vár a terminál a kártyára, utána megszakítjuk (a SumUp ~270 s után zárná). */
    checkoutMaxWaitS: num("CHECKOUT_MAX_WAIT_S", 120),
    cancelMaxWaitS: num("CANCEL_MAX_WAIT_S", 30),
    pollIntervalMs: num("POLL_INTERVAL_MS", 1000),
    queuePollMs: num("QUEUE_POLL_MS", 1500),
    /** A sorban ennél régebben váró kérést lejártnak vesszük. */
    pendingMaxAgeS: num("PENDING_MAX_AGE_S", 900),
  },
  snapify: {
    apiUrl: str("SNAPIFY_API_URL", "https://api.snapify.hu").replace(/\/+$/, ""),
    eventSlug: str("SNAPIFY_EVENT_SLUG"),
    token: str("SNAPIFY_TOKEN"),
    email: str("SNAPIFY_EMAIL"),
    password: str("SNAPIFY_PASSWORD"),
    pollS: num("COUNTER_POLL_S", 10),
  },
  http: {
    host: str("HTTP_HOST", "127.0.0.1"),
    port: num("HTTP_PORT", 8788),
  },
  dataDir: path.resolve(str("DATA_DIR", "data")),
  logDir: path.resolve(str("LOG_DIR", "logs")),
};

export type Cfg = typeof cfg;

export function requireBridge(): void {
  if (!cfg.supabase.bridgeSecret) throw new ConfigError("Hiányzik a BRIDGE_SECRET a .env-ből.");
}

export function requireSumUp(requireReader: boolean): void {
  const s = cfg.sumup;
  const missing = [
    !s.apiKey && "SUMUP_API_KEY",
    !s.merchantCode && "SUMUP_MERCHANT_CODE",
    !s.affiliateAppId && "SUMUP_AFFILIATE_APP_ID",
    !s.affiliateKey && "SUMUP_AFFILIATE_KEY",
    requireReader && !s.readerId && "SUMUP_READER_ID",
  ].filter(Boolean);
  if (missing.length) throw new ConfigError(`Hiányzó beállítás a .env-ben: ${missing.join(", ")}`);
}
