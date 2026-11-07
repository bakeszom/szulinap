import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Új BRIDGE_SECRET (npm run uj-titok): akkor kell, ha a gépen nincs meg a régi .env
 * (pl. Windowson, a Mac .env-je nélkül). A titkot a .env-be írja, és kiírja az SQL-t,
 * amelyet a Supabase SQL Editorban le kell futtatni. Onnantól a RÉGI titok nem működik.
 */
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const secret = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(secret, "utf8").digest("hex");

let text = "";
try {
  text = fs.readFileSync(envFile, "utf8");
} catch {
  /* még nincs .env */
}
const line = `BRIDGE_SECRET=${secret}`;
text = /^BRIDGE_SECRET=.*$/m.test(text) ? text.replace(/^BRIDGE_SECRET=.*$/m, line) : `${line}\n${text}`;
fs.writeFileSync(envFile, text, { mode: 0o600 });

console.log("Új BRIDGE_SECRET beírva a .env-be.\n");
console.log("Futtasd le a Supabase SQL Editorban (nrxalvrmupcgorkzobru projekt):\n");
console.log(`update public.bridge_keys set secret_sha256 = '${hash}' where id = 1;\n`);
console.log("Amíg ez nem fut le, az `npm start` „bridge: rossz titok” hibával áll le.");
