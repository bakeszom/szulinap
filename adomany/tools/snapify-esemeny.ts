import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cfg } from "../src/config.js";

/**
 * A szülinapi snapify-esemény létrehozása egy helyi oldalon (npm run snapify-esemeny).
 *
 * A böngészőben megnyíló oldalon TE lépsz be a snapify operátori fiókoddal; a szkript ezután:
 *   1. létrehozza a `bach-adam-29` eseményt (ha még nincs),
 *   2. feltölti a szülinapi keretet fekvő és álló tájolásban (szelfigep-keretek/snapify/),
 *   3. elmenti a 30 napos operátori tokent (data/snapify-token.txt) – ebből olvassa a gyűjtőszolgáltatás
 *      a nyomatszámot –, és beírja a SNAPIFY_EVENT_SLUG-ot a .env-be,
 *   4. kérésre párosító kódot ad a nyomtató-agenthez.
 * A jelszót sehol nem tárolja és nem írja ki.
 */
const API = cfg.snapify.apiUrl;
const SLUG = process.env.SNAPIFY_EVENT_SLUG?.trim() || "bach-adam-29";
const PORT = 8799;
const here = path.dirname(fileURLToPath(import.meta.url));
const FRAMES = path.resolve(here, "../../szelfigep-keretek/snapify");
const ENV_FILE = path.resolve(here, "../.env");
const TOKEN_FILE = path.join(cfg.dataDir, "snapify-token.txt");

const EVENT = {
  slug: SLUG,
  name: "Bakeszom 29 – Ádám szülinapja",
  venue: "Pacsi, Mester utca – alsó szint",
  eventDate: "2026-11-07T19:00:00+01:00",
  printerLocation: "Az alsó szinten, a szelfigép asztalánál.",
  password: null,
  activeWindow: { from: "2026-11-07T12:00:00+01:00", to: "2026-11-08T08:00:00+01:00" },
  quota: { purchased: 400 },
  perDeviceLimit: { enabled: true, count: 10 },
  copiesPerPhoto: 2,
  secondsPerPrint: 20,
};

const FRAME = JSON.parse(fs.readFileSync(path.join(FRAMES, "frame.json"), "utf8")) as {
  name: string;
  landscape: { size: [number, number]; backplate: string; overlay: string; window: Record<string, number> };
  portrait: { size: [number, number]; backplate: string; overlay: string; window: Record<string, number> };
};

let token = "";
try {
  token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
} catch {
  /* még nincs */
}

async function api<T>(method: string, p: string, body?: unknown): Promise<{ status: number; data?: T; error?: string }> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string; code?: string } };
  return { status: res.status, data: j.data, error: j.error ? `${j.error.code ?? ""} ${j.error.message ?? ""}`.trim() : undefined };
}

function setEnv(key: string, value: string): void {
  let text = "";
  try {
    text = fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    /* új fájl */
  }
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

async function uploadFrame(orientation: "landscape" | "portrait"): Promise<string> {
  const f = FRAME[orientation];
  const form = new FormData();
  form.set("meta", JSON.stringify({ name: FRAME.name, orientation, width: f.size[0], height: f.size[1], window: f.window }));
  form.set("backplate", new Blob([fs.readFileSync(path.join(FRAMES, f.backplate))], { type: "image/png" }), f.backplate);
  form.set("overlay", new Blob([fs.readFileSync(path.join(FRAMES, f.overlay))], { type: "image/png" }), f.overlay);
  const r = await api("POST", `/admin/events/${SLUG}/frame`, form);
  if (r.status !== 200) throw new Error(`Keretfeltöltés (${orientation}) sikertelen: ${r.status} ${r.error ?? ""}`);
  return `Keret feltöltve: ${orientation === "landscape" ? "fekvő" : "álló"}`;
}

async function setup(): Promise<string[]> {
  const log: string[] = [];
  let ev = await api<{ frame?: { landscape?: unknown; portrait?: unknown } | null; name: string }>("GET", `/admin/events/${SLUG}`);
  if (ev.status === 401) throw new Error("A token lejárt, lépj be újra.");
  if (ev.status === 404) {
    const c = await api("POST", "/admin/events", EVENT);
    if (c.status !== 201) throw new Error(`Esemény létrehozása sikertelen: ${c.status} ${c.error ?? ""}`);
    log.push(`Esemény létrehozva: ${EVENT.name} (${SLUG}), 400 nyomat, 10/telefon, fotónként max. 2 példány`);
    ev = await api("GET", `/admin/events/${SLUG}`);
  } else if (ev.status === 200) {
    log.push(`Az esemény már létezik: ${ev.data?.name} (${SLUG}), nem írtam át`);
  } else {
    throw new Error(`Esemény lekérdezése sikertelen: ${ev.status} ${ev.error ?? ""}`);
  }
  if (!ev.data?.frame?.landscape) log.push(await uploadFrame("landscape"));
  else log.push("Fekvő keret már fent van");
  if (!ev.data?.frame?.portrait) log.push(await uploadFrame("portrait"));
  else log.push("Álló keret már fent van");
  setEnv("SNAPIFY_EVENT_SLUG", SLUG);
  log.push(`A gyűjtőszolgáltatás .env-jébe beírva: SNAPIFY_EVENT_SLUG=${SLUG}`);
  return log;
}

const page = `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Snapify esemény</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15111d;color:#fffbe8;font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:520px;background:#fffbe8;color:#0f0d0a;border:4px solid #0f0d0a;border-radius:8px;box-shadow:8px 8px 0 #c6f432;padding:20px;display:grid;gap:12px}
h1{margin:0;font:900 26px/1.1 system-ui}p{margin:0}label{display:grid;gap:4px;font-weight:700}
input{font:600 18px system-ui;padding:10px;border:3px solid #0f0d0a;border-radius:6px;width:100%;box-sizing:border-box}
button{font:900 18px system-ui;padding:12px;border:3px solid #0f0d0a;border-radius:6px;background:#ff4d6d;color:#fffbe8;box-shadow:3px 3px 0 #0f0d0a;cursor:pointer}
button.alt{background:#fff04a;color:#0f0d0a}ul{margin:0;padding-left:20px}.err{color:#c8102e;font-weight:700}.code{font:900 40px/1 ui-monospace,monospace;letter-spacing:.2em;text-align:center;background:#c6f432;border:3px solid #0f0d0a;border-radius:6px;padding:12px}
a{color:#0f0d0a;font-weight:800}small{color:#6b6474}
</style></head><body><div class="card">
<h1>Snapify esemény: Bakeszom 29</h1>
<p>Lépj be a snapify operátori fiókoddal. Utána létrehozom a <b>${SLUG}</b> eseményt, feltöltöm a szülinapi keretet, és elmentem a tokent a képszámlálónak. A jelszót nem tárolom.</p>
<form id="f" style="display:grid;gap:10px">
<label>E-mail<input name="email" type="email" autocomplete="username" required></label>
<label>Jelszó<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Belépés és beállítás</button></form>
<div id="out"></div>
<button class="alt" id="pair" type="button" hidden>Párosító kód a nyomtató-agenthez</button>
<div id="pout"></div>
<small>A token helye: adomany/data/snapify-token.txt (30 napig érvényes).</small>
</div><script>
const out=document.getElementById("out"),pout=document.getElementById("pout");
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function post(p,b){const r=await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})});return r.json();}
function done(j){out.innerHTML=j.ok?"<ul>"+j.log.map(l=>"<li>"+esc(l)+"</li>").join("")+"</ul><p>Vendégoldal: <a href='"+j.guestUrl+"' target='_blank'>"+esc(j.guestUrl)+"</a><br>Admin: <a href='https://snapify.hu/admin' target='_blank'>snapify.hu/admin</a></p>":"<p class='err'>"+esc(j.error)+"</p>";document.getElementById("pair").hidden=!j.ok;}
document.getElementById("f").addEventListener("submit",async e=>{e.preventDefault();out.textContent="Dolgozom…";const fd=new FormData(e.target);done(await post("/login",{email:fd.get("email"),password:fd.get("password")}));e.target.password.value="";});
document.getElementById("pair").addEventListener("click",async()=>{const j=await post("/pairing");pout.innerHTML=j.ok?"<div class='code'>"+esc(j.code)+"</div><p>Érvényes eddig: "+esc(new Date(j.expiresAt).toLocaleTimeString("hu-HU"))+". A Windowson: <b>yarn agent pair "+esc(j.code)+"</b> (lásd a print-agent README-t).</p>":"<p class='err'>"+esc(j.error)+"</p>";});
${token ? `post("/setup").then(j=>{if(j.ok)done(j)});` : ""}
</script></body></html>`;

async function readJson(req: http.IncomingMessage): Promise<Record<string, string>> {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method === "POST" && req.url === "/login") {
      const { email, password } = await readJson(req);
      token = "";
      const r = await api<{ token: string }>("POST", "/admin/auth/login", { email, password, remember: true });
      if (r.status !== 200 || !r.data?.token) return send(200, { ok: false, error: `Belépés sikertelen (${r.status}): ${r.error ?? ""}` });
      token = r.data.token;
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
      console.log("Belépve, token elmentve.");
    }
    if (req.method === "POST" && (req.url === "/login" || req.url === "/setup")) {
      if (!token) return send(200, { ok: false, error: "Előbb lépj be." });
      const log = await setup();
      log.forEach((l) => console.log(l));
      return send(200, { ok: true, log, guestUrl: `https://snapify.hu/foto/${SLUG}` });
    }
    if (req.method === "POST" && req.url === "/pairing") {
      const r = await api<{ code: string; expiresAt: string }>("POST", `/admin/events/${SLUG}/pairing-code`);
      if (r.status !== 200 || !r.data) return send(200, { ok: false, error: `${r.status} ${r.error ?? ""}` });
      console.log(`Párosító kód kiadva (lejár: ${r.data.expiresAt})`);
      return send(200, { ok: true, ...r.data });
    }
    send(404, { ok: false, error: "Nincs ilyen végpont" });
  } catch (err) {
    send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Snapify-esemény beállító: http://127.0.0.1:${PORT}/  (Ctrl+C: kilépés)`));
