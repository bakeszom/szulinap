import { APIError, SumUpError } from "@sumup/sdk";
import { PaymentProviderError, type PaymentErrorCode } from "./types.js";

/**
 * A @sumup/sdk hibáit egységes PaymentProviderError-ra képezi le.
 *
 * Az SDK 0.2.0 viselkedése (dist/index.js):
 *  - nem 2xx válasz → APIError(status, body JSON vagy szöveg, response)
 *  - időtúllépés → SumUpError("Request timed out after …ms.")
 *  - hálózati hiba → a fetch TypeError-ja változatlanul
 *  - alapból NEM próbálkozik újra (maxRetries = 0)
 *
 * A reader-végpontok hibateste: { errors: { type, detail } }, vagy RFC 9457 Problem
 * ({ type: "https://developer.sumup.com/problem/reader-offline", title, status, detail }).
 * Dokumentált reader-hibák (OpenAPI): 422 READER_BUSY „There is a pending checkout
 * for the device.” (a 60 mp-es ablakon belül), 422 READER_OFFLINE „The device is offline.”
 */
export function mapSumUpError(err: unknown, opts: { isCreate?: boolean } = {}): PaymentProviderError {
  if (err instanceof PaymentProviderError) return err;
  const ambiguousOnCreate = opts.isCreate === true;

  if (err instanceof APIError) {
    const status = err.status;
    const { type, detail } = extractErrorBody(err.error);
    const text = `${type ?? ""} ${detail ?? ""}`.toLowerCase();
    const message = `SumUp API ${status}${type ? ` ${type}` : ""}${detail ? `: ${detail}` : ""}`;
    const base = { status, detail: err.error } as const;

    let code: PaymentErrorCode;
    let retryable = false;
    let ambiguous = false;
    if (status === 401 || status === 403) {
      code = "AUTH";
    } else if (status === 429) {
      code = "RATE_LIMITED";
      retryable = true;
    } else if (status >= 500) {
      code = "SERVER";
      retryable = true;
      // 5xx után nem tudhatjuk, hogy a checkout létrejött-e.
      ambiguous = ambiguousOnCreate;
    } else if (/offline/.test(text)) {
      code = "READER_OFFLINE";
      retryable = true;
    } else if (/busy|in progress|already|pending|conflict/.test(text) || status === 409) {
      code = "READER_BUSY";
      retryable = true;
    } else if (/not.?paired|expired/.test(text)) {
      code = "READER_NOT_PAIRED";
    } else if (status === 404) {
      code = "NOT_FOUND";
    } else if (status === 400 || status === 422) {
      code = "INVALID_REQUEST";
    } else {
      code = "UNKNOWN";
    }
    return new PaymentProviderError(code, message, { ...base, retryable, ambiguous, cause: err });
  }

  if (err instanceof SumUpError && /timed out/i.test(err.message)) {
    return new PaymentProviderError("TIMEOUT", err.message, {
      retryable: true,
      ambiguous: ambiguousOnCreate,
      cause: err,
    });
  }

  if (err instanceof TypeError || (err instanceof Error && err.name === "AbortError")) {
    // fetch failed: DNS, kapcsolat bontva, TLS… Lehet, hogy a kérés már elment.
    return new PaymentProviderError("NETWORK", `Hálózati hiba: ${err.message}`, {
      retryable: true,
      ambiguous: ambiguousOnCreate,
      cause: err,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new PaymentProviderError("UNKNOWN", message, { cause: err, ambiguous: ambiguousOnCreate });
}

export function extractErrorBody(body: unknown): { type?: string; detail?: string } {
  if (typeof body === "string") return { detail: body.slice(0, 500) };
  if (!body || typeof body !== "object") return {};
  const obj = body as Record<string, unknown>;
  const errors = obj.errors;
  const inner = Array.isArray(errors) ? errors[0] : errors;
  if (inner && typeof inner === "object") {
    const e = inner as Record<string, unknown>;
    const type = str(e.type) ?? str(e.error_code) ?? str(e.code);
    const detail = str(e.detail) ?? str(e.message);
    // Validációs hiba: {"errors":{"total_amount":["must be greater than 0"], …}}
    if (!type && !detail) return { type: "VALIDATION", detail: JSON.stringify(e).slice(0, 500) };
    return { type, detail };
  }
  return {
    type: str(obj.type) ?? str(obj.error_code) ?? str(obj.code) ?? str(obj.title),
    detail: str(obj.detail) ?? str(obj.message) ?? str(obj.error_message),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
