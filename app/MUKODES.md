# Ádám szülinapi buliapp – működési leírás

Buli: **2026. november 7., szombat, 19:00, Pacsi (Mester utca), alsó szint.**
Várható létszám: kb. 50 fő, akik egyszerre használják az appot a telefonjukon.

Állapot ehhez a leíráshoz: **2026. november 6.** Ami még hátravan, az a végén, a „Nyitott teendők” részben szerepel.

---

## 1. Mi ez röviden

Egy telefonos webapp, amit a vendégek egy QR-kód beolvasásával nyitnak meg. Telepíteni nem kell semmit. Belépés után a következőkkel játszhatnak:

- **Side questek**: kis feladatok pontokért (könnyű, közepes, nehéz, ismerkedős)
- **Piaszámláló**: ki mit ivott, titkos bónuszpontokkal
- **Kvízpiramis**: 10 szintes, egyre nehezebb kvíz örökranglistával
- **Témadobó**: jégtörő kérdések és „az érem két oldala” vitajáték
- **Ki ez az Ádám?**: rövid kvíz a szülinaposról

Mellette két kijelzős nézet fut a kivetítőn vagy a monitoron:

- **App kivetítős nézete** (`#tv`): ranglista, kvízpiramis-csúcsok, „most történt” hírfolyam, fotófal, QR-kód
- **Progress bar kijelző** (`progress.html`): az esküvőre gyűjtés „futása” mérföldkövekkel, plusz a side quest ranglista italokkal

---

## 2. Mit használunk (minden ingyenes)

| Elem | Mire való | Hol van |
|---|---|---|
| **GitHub repo** | Itt van az app összes fájlja | `bakeszom/szulinap` |
| **GitHub Pages** | Kiszolgálja a weboldalt a nyilvános címen | `https://bakeszom.github.io/szulinap/` |
| **Supabase** (ingyenes csomag) | Közös adatbázis: játékosok, pontok, italok, kvízeredmények, feltöltött fotók | projekt: `nrxalvrmupcgorkzobru` |
| **GitHub Actions** | Naponta kétszer megpingeli a Supabase-t, hogy ne álljon le | `.github/workflows/supabase-ebren-tartas.yml` |
| **Google Sheets** | Itt írod a tartalmat (questek, kérdések), innen kerül be az appba | a megosztott „buliapp tartalom” táblázat |

A repóban a meghívó/RSVP oldal (`index.html` a gyökérben) külön él, a buliapp nem nyúl hozzá.

### Címek

| Mire | Cím |
|---|---|
| Vendégeknek (ez van a QR-kódban) | `https://bakeszom.github.io/szulinap/app/` |
| App kivetítős nézete | `https://bakeszom.github.io/szulinap/app/#tv` |
| Progress bar kijelző | `https://bakeszom.github.io/szulinap/app/progress.html` |
| QR-kód (PNG / SVG) | `https://bakeszom.github.io/szulinap/app/qr/buliapp-qr.png` (és `.svg`) |
| A5 poszter nyomtatáshoz | `https://bakeszom.github.io/szulinap/app/qr/buliapp-poszter-A5.pdf` |

### Fájlok a repóban

```
app/
  index.html        ← maga a buliapp (minden kód és tartalom egy fájlban)
  progress.html     ← progress bar kijelző (gyűjtés + ranglista)
  README.md         ← rövid technikai jegyzet
  img/              ← képek Ádámról: adam-1.jpg … adam-8.jpg
  qr/               ← QR-kód és A5 poszter
.github/workflows/
  supabase-ebren-tartas.yml
```

---

## 3. Hogyan működik a háttérben

```
 Vendég telefonja                     Kivetítő / monitor
 (app/index.html)                     (app/#tv és progress.html)
        │                                     │
        │  olvas + ír                         │  csak olvas, pár mp-enként
        ▼                                     ▼
   ┌────────────────────── Supabase ──────────────────────┐
   │ players · completions · drinks · scores · leaderboard │
   │ proofs (fotótároló)                                   │
   └───────────────────────────────────────────────────────┘
```

- Az oldal statikus, a GitHub Pages szolgálja ki. Nincs saját szerver.
- Az app közvetlenül a Supabase-zel beszél a **nyilvános (publishable) kulccsal**. Ez a kulcs szándékosan nyilvános, a kódban is benne van. Hogy ki mit írhat és olvashat, azt az adatbázis szabályai (RLS) döntik el.
- A **ranglistát** egy adatbázis-nézet (`leaderboard`) számolja: összesíti a pontokat, a kész questeket és az italokat. Az app és a progress bar kijelző is ebből olvas, ezért mindkettőn ugyanaz látszik.
- Az app 20 másodpercenként frissíti a ranglistát, a kivetítős nézet 8 másodpercenként, a progress bar 3–6 másodpercenként.
- **Terhelés:** 40 egyidejű vendég szimulálva, 480 kérés 6 másodperc alatt, egyetlen hiba nélkül, kb. 0,4 mp-es válaszidővel. Az 50 fő bőven belefér.

### Adatbázis-táblák

| Tábla / nézet | Mit tárol |
|---|---|
| `players` | Játékosok: név (= felhasználónév), 4 jegyű belépőkód. A kódot más nem láthatja. |
| `completions` | Teljesített side questek és titkos bónuszok: ki, melyik, hány pont, fotó linkje. Egy quest játékosonként csak egyszer. |
| `drinks` | Minden elfogyasztott ital külön sor: ki, milyen fajta, mikor. |
| `scores` | Kvízeredmények: `pyramid` (legjobb piramis-eredmény fél pontokban), `pyr_tries` (próbálkozások száma), `age` (első kor-tipp, 0 = lejárt az idő), `adam` (Ki ez az Ádám? első kitöltés: jó válaszok száma és a kérdések száma). |
| `leaderboard` (nézet) | Játékosonként: pontok, kész questek, sör/bor, long drink, feles, víz darabszám. |
| `resume_player` (függvény) | Visszalépés névvel és kóddal úgy, hogy a kód nem szivárog ki. |
| `proofs` (tároló) | A side questekhez feltöltött bizonyítékfotók. A telefon feltöltés előtt kicsire tömöríti őket. |

---

## 4. A vendég útja

1. **Beolvassa a QR-kódot**, megnyílik az app a telefonja böngészőjében.
2. **Beírja a nevét.** Ez a **felhasználóneve**. Két egyforma név nem lehet: ha a „Peti” foglalt, az app szól, hogy írjon mellé egy kezdőbetűt („Peti K.”).
3. **Kap egy 4 jegyű belépőkódot.** Az app megmutatja, és kéri, hogy csináljon róla képernyőképet. A kód a főoldal alján is mindig látszik.
4. Innentől **ott folytatja, ahol abbahagyta**: ha bezárja és újra megnyitja az appot ugyanazon a telefonon, minden megvan.
5. Ha mégis elveszne a belépése (privát böngésző, törölt előzmények, másik telefon), a **„Már játszottam, visszalépek a kódommal”** gombbal, a nevével és a kódjával visszajut. Minden pontja megmarad, mert azok az adatbázisban vannak, nem a telefonon.

---

## 5. A játékok részletesen

### 5.1 Side questek

- **Négy kategória** fülekkel: **Könnyű**, **Közepes**, **Nehéz**, **Ismerkedős**. Mindenki szabadon választ, nincs zárolás.
- Minden quest egy „jegy” a pontértékével. Teljesítés után: **„Megcsináltam”**, és a pont azonnal jóváíródik.
- A **nehéz** questeknél **fotó kötelező**, a többinél opcionális. A fotók a kivetítő fotófalára kerülnek.
- **Becsületkassza:** mindenki maga pipálja ki, amit megcsinált. Visszavonni is lehet („Mégsem csináltam meg”).
- Az egyik könnyű quest (beugratós kérdés) minden alkalommal egy véletlen beugratós kérdést mutat a listából.

### 5.2 Piaszámláló

- A főoldalon, közvetlenül a side questek alatt, ugyanakkora kártyán.
- Négy sor, mindegyik **− / +** gombbal: **Long drink**, **Sör / bor**, **Feles**, **Üdítő / víz**.
- Minden ital külön számít. A **−** az adott fajtából az utolsót vonja vissza.
- **Titkos bónuszok:** sehol nincsenek kiírva, csak elérésükkor ugrik fel egy ablak.

  | Mikor | Név | Pont |
  |---|---|---|
  | 5. long drink | Long drink-mester | +5 |
  | 3. feles | Feleshős | +3 |
  | 3. üdítő / víz | Vízfelelős | +2 |

  A bónuszpont a ranglistára megy. Ha valaki visszavon egy italt a küszöb alá, a bónusz is lejön.
- A ranglistán minden név mellett ott vannak az ital-ikonok a darabszámokkal, a kivetítőn és a progress bar kijelzőn is.

### 5.3 Kvízpiramis

- **10 szint.** Az **1. szint fixen**: „Hány éves lett ma Ádám?” (27 / 28 / 29 / 30, a helyes válasz **29**).
  - Mindenkitől **csak az első tippet** mentjük el. Válasz után kiírja, hányan találták el, hányan gondolják idősebbnek és hányan fiatalabbnak.
  - Ugyanez megjelenik a kivetítős nézet fejlécében és a progress bar kijelzőn is (lásd 5.8).
- A **2–10. szint** 9 nehezedő szint. Szintenként 2 kérdés van, az app ezek közül sorsol, így összesen 18 kérdés van a sorsolásban. A válaszok sorrendjét keveri.
- Kérdésenként **20 másodperc**. Egy rossz válasz vagy lejárt idő, és lezuhansz.
- **Pontozás:** minden megmászott szint **1 pont**. **Újra lehet próbálni**, de onnantól szintenként csak **fél pont** jár. A **legjobb** eredmény számít.
- **Örökranglista** a legjobb eredményekkel. Holtversenynél a gyorsabb nyer.
- Ha valaki játék közben bezárja az appot, az a próbálkozás elhasználódik.

### 5.4 Témadobó

- **Jégtörők** (alapból ez nyílik): egy véletlen kérdés, amit fel lehet tenni valakinek, akit most ismersz meg. A „Másikat kérek” gombbal újat húz.
- **Az érem két oldala:** egy vitatéma két oldallal. Ketten játsszák: az app kisorsolja, ki melyik oldalt védi, és **2 perces időzítő** indul. A végén a körülöttük állók döntik el, ki nyert.
- Mindkét játék tetején van egy rövid leírás arról, mit kell csinálni.

### 5.5 Ki ez az Ádám?

- Rövid, 5 kérdéses kvíz képekkel. Minden válasz után megjelenik egy kis infó vagy sztori.
- **Mindenkinek az első kitöltése számít.** Az eredményoldal kiírja, hányan válaszoltak minden kérdésre jól. Alatta lenyitható a **„Mindent tudók klubja”** a nevekkel.
- A főoldali kártyán, a kivetítőn és a progress bar kijelzőn is látszik, hányan tudnak mindent Ádámról.
- A főoldalon lejjebb van, a ranglista alatt.

### 5.6 Felugró ablakok

- Kb. 4 percenként (véletlenszerűen) feldob egy üzenetet egy random képpel Ádámról, pl. „Hívd meg a szülinapost egy shotra”.
- Nem ugrik fel, ha épp megy a kvízpiramis, ha nyitva van egy másik ablak, vagy ha a telefon le van zárva.

### 5.7 Kivetítős nézet (`#tv`)

- Ranglista italokkal, kvízpiramis-csúcsok, „most történt” hírfolyam (a titkos bónuszok is), a nehéz questek fotói, QR-kód a beszálláshoz.
- Fejléc-statisztikák: hány kész quest, hány ital, hányan tippelték félre a korát.
- 8 másodpercenként frissül, kézzel semmit nem kell csinálni.

### 5.8 Progress bar kijelző (`progress.html`)

- Külön kijelző: az **esküvőre gyűjtés** „futása” egy pályán, mérföldkövekkel (pl. 10 000 Ft-nál Ádám lehúz egy korsó sört). A mérföldkövek a fájl elején, a `MILESTONES` listában szerkeszthetők.
- A **befizetéseket és a szelfigépes képek számát** Dávid oldala küldi (JSON-feed `?feed=URL` paraméterrel, `postMessage`, vagy JS API). A részletek a fájl tetején, a kommentben vannak.
- A **side quest ranglistát és a hírszalagot** ugyanabból a Supabase-ből olvassa, mint az app, a long drink és feles számokkal együtt. A „Kész quest” számláló csak a valódi side questeket számolja, a pia-bónuszokat nem.
- **„Hány éves Ádám?” rubrika** a következő mérföldkő mellett, 10 másodpercenként frissül: hányan gondolják **idősebbnek**, hányan **fiatalabbnak**, és hányan **tudnak mindent** Ádámról. A valódi kor a fájlban az `ADAM_AGE` értéke (29).

---

## 6. Tartalom szerkesztése

- A szövegek (questek, kvízkérdések, dilemmák, jégtörők, beugratós kérdések, felugró üzenetek, piák és bónuszok) az `app/index.html` elején, a **`CONTENT`** blokkban vannak.
- A kényelmes út: **a Google táblázatban írod**, szólsz, én beolvasom és frissítem vele az appot.
  - **Side questek lap:** a **Szint** oszlopba a kategória kerül (könnyű / közepes / nehéz / ismerkedős). Pont, fotó kötelező (igen/nem), feladat szövege, megjegyzés.
  - Az ID oszlopot ne írd át. Új sornál hagyd üresen, kiosztom.
  - A „Besoroló kérdések” lap már nem kell.
- **Képek Ádámról:** `app/img/adam-1.jpg` … `adam-8.jpg`. Max. ~1500 px, 300–500 KB. Ha egy hiányzik, sárga helykitöltő jelenik meg.
- A buli napján már nem tervezünk szerkeszteni.

### Frissítés menete (ezt én csinálom)

1. Módosítás az `app/index.html`-ben.
2. Teszt a gépen demó módban (minden képernyő végigkattintva, mobil szélesség).
3. Feltöltés a GitHubra. Kb. 1 perc múlva él a nyilvános címen.
4. Ellenőrzés az élő oldalon.

A vendégek a következő megnyitáskor vagy frissítéskor már az új verziót kapják.

---

## 7. Biztonság és határok

- **Becsületalapú játék.** Bárki kipipálhat bármit, nincs nyeremény, nincs mit védeni. Egyetlen valódi védelem van: a belépőkódot más nem láthatja, így senki nem léphet be más nevében.
- A nyilvános kulcs és a QR-kód bárkinél működik, akinél ott van a link.
- **Supabase ingyenes csomag:** ha egy hétig nincs forgalom, a projekt leáll. Ezt előzi meg a naponta kétszer futó pingelés. Ha mégis leállna, a Supabase felületén pár perc alatt vissza lehet indítani, az adatok megmaradnak.
- A fotók nyilvános linken érhetők el, aki ismeri a pontos címüket.

---

## 8. Buli előtti teendők (nov. 7., délelőtt)

1. **Supabase-en nézd meg, hogy fut-e a projekt** (nincs „Paused” felirat).
2. **Tesztadatok törlése:** Supabase → SQL Editor:

   ```sql
   truncate public.photos, public.drinks, public.completions, public.scores, public.players restart identity cascade;
   ```

3. **Fotók törlése:** Supabase → Storage → `proofs` → Empty bucket.
4. Telefonon **olvasd be a kinyomtatott QR-t**, lépj be, pipálj ki egy questet, nyomj egy italt. Utána nézd meg a kivetítőn, hogy megjelent-e.
5. A saját tesztjátékosodat töröld újra a 2. ponttal, vagy maradhat, ha így is jó.
6. Kivetítőn megnyitni: `…/app/#tv` és/vagy `…/app/progress.html`, teljes képernyőn.

Aki a törlés előtt már belépett (pl. teszteléskor), annak az app automatikusan szól, hogy lépjen be újra.

---

## 9. Ha valami gond van a bulin

| Tünet | Mit csinálj |
|---|---|
| Valaki nem tud visszalépni, elfelejtette a kódját | Supabase → Table editor → `players` → a `code` oszlopban látod a nevénél. |
| „Nem sikerült menteni” üzenetek | Rossz a térerő vagy a wifi. Próbálja újra, nem vész el semmi. |
| Senkinél nem megy semmi | Supabase → nézd meg, nincs-e leállítva (Paused). Ha igen: Restore. |
| A kivetítő nem frissül | Frissítsd a böngészőt a kivetítős gépen. |
| Valaki csal a pontokkal | Supabase → `completions` vagy `drinks` táblában törölhetők a sorai. |

---

## 10. Nyitott teendők (nov. 5. állapot)

- [x] **SQL lefuttatása** Supabase-en (belépőkód, piaszámláló tábla, italos ranglista) – kész, nov. 6.
- [x] **Side questek** végleges listája – bent, nov. 6.
- [x] **Ki ez az Ádám?** 6 saját kérdése – bent, nov. 6.
- [x] Matricák: 22 db (a `STICKERS` lista vezérli az `index.html` elején).
- [x] Az új verzió élesítése és élő teszt – kész, nov. 6. (az új tartalom és a képek után még egyszer frissítjük)
- [ ] Buli előtti takarítás (8. pont).
