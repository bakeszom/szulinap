import { cfg } from "./config.js";

/** A buliapp Supabase-ének REST-je (PostgREST). Ugyanaz a nyilvános kulcs, mint a buliappban. */

export type RequestStatus = "pending" | "sent" | "paid" | "failed" | "cancelled" | "expired";

export interface DonationRequest {
  id: number;
  player_id: string | null;
  name: string;
  amount: number;
  source: "app" | "kiosk";
  status: RequestStatus;
  cancel_requested: boolean;
  info: string | null;
  tx_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProgressFeed {
  total: number;
  count: number;
  max: number;
  photos: number | null;
  queue: number;
  last: { id: string; amount: number; name: string } | null;
}

export class SupabaseError extends Error {
  override readonly name = "SupabaseError";
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function rest<T>(pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${cfg.supabase.url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: cfg.supabase.key,
      Authorization: `Bearer ${cfg.supabase.key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let code: string | undefined;
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { code?: string; message?: string };
      code = j.code;
      message = j.message ?? message;
    } catch {
      /* nem JSON */
    }
    throw new SupabaseError(res.status, `Supabase ${res.status}: ${message}`, code);
  }
  return (text ? JSON.parse(text) : null) as T;
}

const secret = () => cfg.supabase.bridgeSecret;

export const sb = {
  listOpen: () =>
    rest<DonationRequest[]>("donation_requests?select=*&status=in.(pending,sent)&order=id.asc&limit=100"),

  get: async (id: number) => (await rest<DonationRequest[]>(`donation_requests?select=*&id=eq.${id}`))[0],

  recent: (limit = 12) =>
    rest<DonationRequest[]>(`donation_requests?select=*&order=id.desc&limit=${limit}`),

  insertRequest: async (body: { name: string; amount: number; source: "app" | "kiosk"; player_id?: string | null }) =>
    (
      await rest<DonationRequest[]>("donation_requests", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body),
      })
    )[0]!,

  cancelRequest: (id: number) => rest<string>("rpc/cancel_donation_request", { method: "POST", body: JSON.stringify({ p_id: id }) }),

  feed: () => rest<ProgressFeed>("rpc/progress_feed", { method: "POST", body: "{}" }),

  updateRequest: (id: number, status: RequestStatus, info: string | null, txCode: string | null = null) =>
    rest<null>("rpc/bridge_update_request", {
      method: "POST",
      body: JSON.stringify({ p_secret: secret(), p_id: id, p_status: status, p_info: info, p_tx_code: txCode }),
    }),

  addDonation: (requestId: number | null, txCode: string | null, name: string, amount: number) =>
    rest<number>("rpc/bridge_add_donation", {
      method: "POST",
      body: JSON.stringify({ p_secret: secret(), p_request_id: requestId, p_tx_code: txCode, p_name: name, p_amount: amount }),
    }),

  setCounter: (key: string, value: number) =>
    rest<null>("rpc/bridge_set_counter", {
      method: "POST",
      body: JSON.stringify({ p_secret: secret(), p_key: key, p_value: value }),
    }),

  reset: () => rest<null>("rpc/bridge_reset", { method: "POST", body: JSON.stringify({ p_secret: secret() }) }),
};
