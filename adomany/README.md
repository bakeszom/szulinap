# Gyűjtőgép: kártyás beszállás Ádám esküvőjére + szelfigép-számláló

Kis Node-szolgáltatás a buli laptopjára (Windows vagy Mac). Három dolgot csinál:

1. **Kártyás gyűjtés.** A vendég a buliappban (Gyűjtés az esküvőre) vagy a helyi kezelőoldalon összeget választ. A szolgáltatás sorban elküldi a kéréseket a SumUp terminálra, a vendég odaérinti a kártyáját, és a befizetés a nevével megjelenik a kivetítőn.
2. **Szelfigép-számláló.** 10 mp-enként lekérdezi a snapify API-tól, hány lapot nyomtatott a mozgó szelfigép a `bach-adam-29` eseményen, és ezt a kivetítő „Szelfi fotó” mezőjébe írja.
3. **Kezelőoldal** a laptopon: http://127.0.0.1:8788. Itt látszik, mi van épp a terminálon és mi áll a sorban. Ide lehet beírni annak az összegét, aki nem a buliappból szállna be, és itt rögzíthető a készpénz is.

A SumUp-részt a **snapify-pay** kódja adja (`src/sumup/`: `SumUpProvider`, hibaleképezés, pénzkezelés; változatlanul átvéve, csak az importok igazítva). Ugyanaz a **SumUp sandbox-fiók** (`M5W77HE7`), mint a snapify-payé, ezért **tesztpénzzel** megy. Éles fiókkal a szolgáltatás csak `SUMUP_ALLOW_LIVE=true` mellett indul el.

```
 buliapp (telefon) ─┐                                        ┌─► progress.html (kivetítő)
 kezelőoldal ───────┼─► Supabase: donation_requests ──► adomany ──► SumUp terminál ──► donations
                    │                                        │
 snapify API (nyomatszám) ─────────────────────────► adomany ──► counters('photos')
```

## Egyszeri beállítás

1. **Supabase SQL:** `app/supabase-v4-adomany.sql` → Supabase → SQL Editor → Run. Csak új táblákat és függvényeket ad hozzá.
2. **Node 22+** (Windowson a hivatalos telepítővel), majd ebben a mappában: `npm install`.
3. **`.env`** a `.env.example` alapján. A Macen ez már kész: a SumUp-kulcsok a snapify-pay `.env`-jéből jöttek, a `BRIDGE_SECRET` ehhez az SQL-hez tartozik. Másik gépre **másold át a `.env`-et és a `data/snapify-token.txt`-t** (egyik sincs gitben). Ha a régi `.env` nincs meg: `npm run uj-titok` új titkot ír a `.env`-be, és kiírja az egysoros SQL-t, amit a Supabase SQL Editorban le kell futtatni.
4. **Terminál párosítása** (gépenként egyszer):
   - **Virtual Solo (sandbox):** nyisd meg a https://virtual-solo.sumup.com oldalt azon a telefonon vagy tableten, amely a „terminál” lesz, és kattints a „Generate pairing code” gombra. Utána: `npm run pair -- <KÓD>`. A kiírt `SUMUP_READER_ID=rdr_…` sor menjen a `.env`-be.
   - A Mac tesztbotja (`rdr_5HK58…`) a snapify-pay `npm run solo-bot -- run --policy=pay` parancsával fizet automatikusan, ez csak teszteléshez kell.
5. **Snapify-esemény + token:** `npm run snapify-esemeny`, majd a megnyíló oldalon (http://127.0.0.1:8799) belépés. Ez létrehozza az eseményt, feltölti a keretet, és elmenti a tokent.

## A bulin

```bash
npm start                 # gyűjtés + számláló + kezelőoldal (http://127.0.0.1:8788)
```

- Kivetítő: `https://bakeszom.github.io/szulinap/app/progress.html?live`
- A buli előtti tesztbefizetések törlése: `npm run reset -- --igen`, utána a kivetítőn egyszer `progress.html?live&reset`.
- Leállítás: Ctrl+C. Ha épp fizetés van a terminálon, megszakítja. Ha a folyamatot kilövik, induláskor folytatja a terminálon lévő fizetés figyelését (`data/inflight.json`).

## Parancsok

| Parancs | Mit csinál |
|---|---|
| `npm start` | szolgáltatás |
| `npm run pair -- <KÓD>` | Solo / Virtual Solo párosítása |
| `npm run readers` | a SumUp-fiók readerei |
| `npm run status` | reader-állapot + a gyűjtés állása |
| `npm run terminate` | a terminálon függő fizetés megszakítása |
| `npm run reset -- --igen` | MINDEN befizetés, kérés és számláló törlése |
| `npm run snapify-esemeny` | snapify-esemény létrehozása, keret, token, párosító kód az agenthez |
| `npm run uj-titok` | új `BRIDGE_SECRET` a `.env`-be + a Supabase-be bemásolandó SQL |
| `npm run typecheck` | típusellenőrzés |

## Hogyan megy egy befizetés

1. A kérés `pending` állapotban bekerül a sorba (`donation_requests`). Egy vendégnek egyszerre egy nyitott kérése lehet.
2. A szolgáltatás a legrégebbit elküldi a terminálra (`sent`), a buliapp pedig kiírja: „Érintsd a kártyádat…”.
3. Sikeres fizetésnél előbb a helyi naplóba ír (`data/befizetesek.jsonl`), utána a Supabase-be (`donations`, idempotens). Ha a Supabase épp nem elérhető, a háttérben újrapróbálja.
4. Ha 120 mp alatt nem jön kártya, a vendég a „Mégse” gombot nyomja, vagy a terminálon megszakítja, a kérés `expired` / `cancelled` lesz. Elutasított kártyánál `failed`. Megszakítás után a SumUp tranzakciólistája dönt, hogy nem fizették-e ki mégis (a snapify-pay mérése szerint a lejárt checkout is kifizethető maradhat).
5. A 15 percnél régebben a sorban váró kéréseket lejártnak veszi.

## Ha valami gond van

| Tünet | Teendő |
|---|---|
| A kezelőoldal piros „Terminál: OFFLINE” | Virtual Solo: legyen nyitva és online a terminál oldala; fizikai Solo: wifi / töltés |
| „SumUp-hitelesítési hiba” | rossz vagy lejárt `SUMUP_API_KEY` |
| „Szelfigép: hiba … token” | `npm run snapify-esemeny` → belépés (új token), majd `npm start` újra |
| A kivetítőn nem nő az összeg | kezelőoldal: van-e Supabase-hiba; a `progress.html?live` címet használod-e |
| Rossz titok (`bridge: rossz titok`) | a `.env` `BRIDGE_SECRET`-je nem az SQL-ben lévő hash-hez tartozik |
| Valami a terminálon ragadt | `npm run terminate` |
