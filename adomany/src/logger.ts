import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";

/**
 * Egyszerű napló: konzolra olvashatóan, fájlba JSON-sorként (logs/adomany-ÉÉÉÉ-HH-NN.log).
 * A snapify-pay SumUpProvider `log.info(obj, msg)` alakban hív, ezt tudja.
 * Titkot (API-kulcs, BRIDGE_SECRET, jelszó, token) nem írunk ki.
 */
type Fields = Record<string, unknown>;
type LogFn = (objOrMsg: Fields | string, msg?: string) => void;
export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

const SECRET_KEYS = /secret|password|token|apikey|api_key|affiliate_key|authorization/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (v instanceof Error) return { name: v.name, message: v.message, code: (v as { code?: unknown }).code };
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Fields = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? "***" : redact(x, depth + 1);
  return out;
}

let stream: fs.WriteStream | undefined;
let streamDay = "";
function fileStream(): fs.WriteStream | undefined {
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });
  if (stream && streamDay === day) return stream;
  try {
    fs.mkdirSync(cfg.logDir, { recursive: true });
    stream?.end();
    stream = fs.createWriteStream(path.join(cfg.logDir, `adomany-${day}.log`), { flags: "a" });
    streamDay = day;
  } catch {
    stream = undefined;
  }
  return stream;
}

function write(level: "info" | "warn" | "error", objOrMsg: Fields | string, msg?: string): void {
  const fields = typeof objOrMsg === "string" ? {} : (redact(objOrMsg) as Fields);
  const text = typeof objOrMsg === "string" ? objOrMsg : (msg ?? "");
  const time = new Date();
  const hm = time.toLocaleTimeString("hu-HU", { timeZone: "Europe/Budapest" });
  const extra = Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  const line = `${hm} ${level === "info" ? "" : level.toUpperCase() + " "}${text}${extra}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  fileStream()?.write(JSON.stringify({ time: time.toISOString(), level, msg: text, ...fields }) + "\n");
}

export const log: Logger = {
  info: (o, m) => write("info", o, m),
  warn: (o, m) => write("warn", o, m),
  error: (o, m) => write("error", o, m),
};

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
