# Ádám szülinapja – útmutató Claude-nak (folytatás Windowson)

Ezt a fájlt a Claude Code minden munkamenet elején beolvassa. A munka macOS-en folyt (2026-11-07 délután). A buli estéjén a **Windows-laptopon** fut a mozgó szelfigép (snapify nyomtató-agent) és a kártyás gyűjtés (`adomany/`); innen folytatódik.

**A repó NYILVÁNOS** (GitHub Pages: https://bakeszom.github.io/szulinap/). Titok (API-kulcs, `BRIDGE_SECRET`, token, jelszó) soha nem kerülhet bele, ebbe a fájlba sem.

## Kommunikáció és szabályok

- **Mindig magyarul**: válaszok, státuszüzenetek, dokumentáció, commit-üzenetek. Kódban az azonosítók angolul, a kommentek és a log-üzenetek magyarul.
- **Push = élesítés:** a `main` ág a GitHub Pagesen ~1 perc múlva él, a vendégek telefonján és a kivetítőn is. Commitolni és pusholni csak akkor szabad, ha a felhasználó kéri. Commit-üzenetbe ne kerüljön Claude-attribúció (`Co-Authored-By`).
- **Csak sandbox:** a SumUp-fiók a snapify-pay sandbox merchantje (`M5W77HE7`), tesztpénz. Éles fiókhoz (`SUMUP_ALLOW_LIVE=true`) csak a felhasználó kifejezett döntésével lehet nyúlni.
- **Folyamatot csak PID alapján állíts le** (`taskkill /PID <pid>`), név vagy minta alapján soha. A gépen a nyomtató-agent és a böngésző is fut.
- Egyszerre **egy** `adomany` példány fusson (a 8788-as porton), és a snapify API-t a buli napján ne deployold.
- A Supabase meglévő SQL-fájljait ne írd át. Ha új séma kell, új fájl kerüljön az `app/` alá (`supabase-v5-….sql`), és azt a felhasználó futtatja le az SQL Editorban.

## Mi van a repóban

| Hely | Mi ez |
|---|---|
| `index.html` (gyökér) | meghívó / RSVP, a buliapp nem nyúl hozzá |
| `app/index.html` | **buliapp** (vendégek telefonján): questek, piaszámláló, kvízek, fotók, **Gyűjtés az esküvőre** (kártyás beszállás), **Szelfigép** csempe |
| `app/progress.html` | **kivetítő**: gyűjtés-pálya mérföldkövekkel, ranglista. Élesben: `progress.html?live` |
| `app/MUKODES.md` | a buliapp teljes működési leírása, a **buli előtti teendők (8. pont)** és a hibaelhárítás |
| `app/supabase-v4-adomany.sql` | a gyűjtés táblái és függvényei (**nov. 7-én lefuttatva**) |
| `adomany/` | **gyűjtőszolgáltatás** (Node + TypeScript, tsx-szel fut): sor → SumUp terminál → befizetés; szelfigép-számláló; helyi kezelőoldal. Leírás: `adomany/README.md` |
| `szelfigep-keretek/snapify/` | a snapify eseményre feltöltött keret (1844×1240 és 1240×1844, overlay + fehér backplate, `frame.json`) |

## Állapot (2026-11-07, 15:30)

- ✅ **Snapify esemény** az éles API-n: `bach-adam-29` („Bakeszom 29 – Ádám szülinapja”), vendégoldal: https://snapify.hu/foto/bach-adam-29. Jellemzői:
  - 400 nyomat, telefononként 10, fotónként max. 2 példány; aktív 2026-11-07 12:00 és 11-08 08:00 között; jelszó nélkül;
  - a keret mindkét tájolásban fent van;
  - **a nyomtató még nincs párosítva**: ez az első Windowsos feladat.
- ✅ **Gyűjtés:** a Macen, a valódi SumUp sandboxszal végponttól végpontig kipróbálva:
  - sima fizetés; sorban álló kérések; vendég-visszavonás a terminálon lévő fizetés közben; Mégse a terminálon; készpénz;
  - összeomlás fizetés közben: az újraindult szolgáltatás folytatta a figyelést és rögzítette a befizetést;
  - a buliapp élesben (küldéstől a „Köszi!”-ig ~7 s); a kivetítő élő reakciója.
  - A tesztbefizetések törölve, a gyűjtés 0-ról indul.
- ✅ **Szelfigép-számláló:** az `adomany` a snapify API operátori élő nézetéből (`/admin/events/bach-adam-29/live` → `quota.used`) olvassa a kinyomtatott lapokat, és a kivetítő „Szelfi fotó” mezőjébe írja.
- ⚠️ A teszteléshez a közös adatbázisban maradt egy „TESZT Gyűjtés” játékos (és reggelről más „TESZT …” játékosok). A buli előtti takarítás (`app/MUKODES.md` 8. pont) törli őket.
- ⚠️ Nincs kipróbálva, mit csinál a sandbox-fiókba párosított **fizikai Solo** egy valódi bankkártyával. Valódi pénz biztosan nem mozdul.

## Teendők Windowson, sorrendben

### 1. Előfeltételek

Node 22+ (nodejs.org telepítő; ne Voltával), Git for Windows (`git config core.autocrlf false`), Yarn 4.5.3 a snapifyhoz (`corepack enable yarn --install-directory "$env:APPDATA\npm"`), Google Chrome.

### 2. Szelfigép: snapify nyomtató-agent

1. A snapify repó (privát: `git@github.com:kosztdav/snapify.git`) **`feat/windows-agent`** ágán van a Windowsos agent (agent 1.2.1, okt. 2-án pusholva, a mainben még nincs benne).
   - `git fetch`, `git checkout feat/windows-agent`, a gyökérben `yarn install`.
2. Részletes lépések: `apps/print-agent/README.md` Windows-része, mért tények: `docs/print-agent-windows-jelentes.md`. Röviden:
   - **Párosító kód:** a snapify.hu/admin oldalon a `bach-adam-29` esemény → Nyomtató → Párosítás. Vagy itt az `adomany` mappában `npm run snapify-esemeny` → belépés → „Párosító kód…” gomb. A kód 10 percig él.
   - `yarn agent printers`
   - `yarn agent pair <KÓD> --url https://api.snapify.hu --printer "HiTi P525L"`
   - `yarn agent start`
   - Az adminban: papír darabszáma, majd **tesztnyomat a kerettel**. Nézd meg, nem vág-e le valamit a keret széle (a „29” matrica balra fent, a QR balra lent).
3. A laptop fedelének lecsukása: „Ne tegyen semmit”, hálózatról soha ne aludjon.

### 3. Kártyás gyűjtés: `adomany/`

1. `cd adomany`, majd `npm ci`.
2. **`.env`:** nincs gitben. Három lehetőség, ebben a sorrendben:
   - a) **A Mac `adomany/.env`-jét** (és `adomany/data/snapify-token.txt`-jét) a felhasználó átmásolja. Ez a legegyszerűbb, minden benne van.
   - b) A `.env.example`-ből. A SumUp-kulcsokat (`SUMUP_API_KEY`, `SUMUP_MERCHANT_CODE`, `SUMUP_AFFILIATE_APP_ID`, `SUMUP_AFFILIATE_KEY`) a gépen lévő **snapify-pay `.env`**-jéből veheted, ha ott van (a mini PC-n igen); különben a felhasználótól kérd. Ugyanaz a sandbox-fiók.
     - Titok: `npm run uj-titok`. Ez új `BRIDGE_SECRET`-et ír a `.env`-be, és kiír egy egysoros SQL-t (`update public.bridge_keys …`), amit a felhasználónak le kell futtatnia a Supabase SQL Editorban. Utána a régi (Maces) titok már nem működik.
     - A SumUp-kulcsok értékét soha ne írd ki a chatbe.
   - c) Ha nincs snapify-token: `npm run snapify-esemeny`. Ez megnyit egy helyi oldalt (http://127.0.0.1:8799), ahol a felhasználó belép. A meglévő eseményt nem írja át, csak elmenti a 30 napos tokent a `data/snapify-token.txt`-be.
     - **Jelszót a felhasználó helyett ne írj be.**
3. **Terminál (`SUMUP_READER_ID`):** a Maces `.env`-ben a Mac tesztbotjának readere áll (`rdr_5HK58YJMC092KRWCZ2EYCRHQDT`), ezt a bulira át kell írni.
   - A fiók readerei: `npm run readers`.
   - **Fizikai Solo** (a sandbox-fiókba párosítva): `rdr_1572B819CQ8T095SCTJHK5B6NP`. Nov. 7-én offline volt, 37%-os akkuval, ezért fel kell tölteni és be kell kapcsolni. Ellenőrzés: `npm run status` → `online: true`.
   - **Vagy Virtual Solo** egy telefonon vagy tableten: https://virtual-solo.sumup.com → „Generate pairing code”, majd `npm run pair -- <KÓD>`. A kiírt `rdr_…` megy a `.env`-be.
   - Teszteléshez fej nélküli bot: a snapify-pay `npm run solo-bot -- pair --write-env` és `run --policy=pay`. Egy readerhez egy bot, és ne párhuzamosan a snapify-pay tesztjeivel.
4. `npm start`, majd a kezelőoldal: http://127.0.0.1:8788. Itt kell látszania:
   - a SANDBOX jelzésnek;
   - „Terminál: online” állapotnak;
   - „Szelfigép: N nyomat” számnak.
5. **Próba:** egy befizetés a buliappból (Gyűjtés az esküvőre) vagy a kezelőoldalról. Utána `npm run reset -- --igen`, a kivetítőn pedig egyszer `progress.html?live&reset`.

### 4. Buli előtt

`app/MUKODES.md` 8. pont: Supabase-takarítás (a `truncate … players … cascade` a gyűjtés tábláit is üríti), kivetítő `…/app/progress.html?live` teljes képernyőn, gyűjtés-próba és reset.

## Hogyan működik a gyűjtés (röviden)

```
buliapp / kezelőoldal ─► Supabase donation_requests (pending)
                              │  az adomany 1,5 mp-enként a legrégebbit veszi
                              ▼
                     SumUp Cloud API checkout ─► terminál ─► vendég kártyája
                              │  1 mp-es polling; 120 s után vagy vendég-visszavonásra terminate,
                              │  majd a Transactions API dönt (lejárt checkout is kifizethető lehet)
                              ▼
     data/befizetesek.jsonl (helyi napló) ─► bridge_add_donation (idempotens) ─► donations
                                                                              │
                                    progress.html?live ◄── progress_feed() ◄──┘ (3 mp-enként)
```

- Írni csak a `bridge_*` függvények tudnak, a `BRIDGE_SECRET`-tel. Az SQL-ben a titoknak csak a SHA-256 hash-e van. Az anon (buliapp) kérést szúrhat be (500 és 500 000 Ft között), olvashat, és a `cancel_donation_request`-tel visszavonhat.
- Egy játékosnak egyszerre egy nyitott kérése lehet. A 15 percnél régebben a sorban váró kérés lejár.
- `src/sumup/`: a **snapify-pay** `SumUpProvider`-e, `errors.ts`-e, `types.ts`-e és `money.ts`-e, változatlanul (csak az importok igazítva). Ha ott javítás jön, ide is át kell vinni.
- Fontos fájlok:
  - `adomany/src/worker.ts`: a sor és a fizetési ciklus;
  - `counter.ts`: a szelfigép-számláló;
  - `http.ts` + `kiosk.html`: a kezelőoldal;
  - `index.ts`: a parancsok.

## Ellenőrzés módosítás után

- `adomany`: `npm run typecheck` (zöld kell). Végponttól végpontig: `npm start` + Virtual Solo (vagy bot) + egy kérés a kezelőoldalról, utána `npm run reset -- --igen`.
- `app/*.html`: helyben kiszolgálva (pl. `npx http-server` vagy `python -m http.server`) mobil szélességben végigkattintva. Ha nem töltődik be a supabase-js, az app demó módban fut, és a gyűjtést 3 s / 8 s után szimulálja.
