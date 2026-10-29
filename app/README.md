# Ádám szülinapi buliapp

Egyetlen oldal (`index.html`) + képek (`img/`). Az adatok a Supabase-ben vannak, a kulcsok már be vannak írva.

## Feltöltés GitHub Pagesre

1. A repóba töltsd fel az `index.html`-t és az `img/` mappát (a gyökérbe).
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `(root)` → Save.
3. Pár perc múlva él: `https://<felhasznalonev>.github.io/<repo>/`

## Képek Ádámról

Tedd az `img/` mappába ezekkel a nevekkel: `adam-1.jpg` … `adam-8.jpg`.
Jó, ha kicsik (max ~1500 px, 300–500 KB). Ha valamelyik hiányzik, helykitöltő jelenik meg.

## Címek a bulin

- Vendégeknek (ez megy a QR-kódba): `https://…/index.html`
- Kivetítő / monitor: `https://…/index.html#tv`  (a kivetítős nézeten is van QR-kód)

## Buli előtt: tesztadatok törlése

Supabase → SQL Editor:

```sql
truncate public.completions, public.scores, public.players restart identity cascade;
```

Utána Supabase → Storage → `proofs` bucket → **Empty bucket**.

## Tartalom módosítása

Az `index.html` elején, a `CONTENT` blokkban van minden szöveg: questek (`quests`), besoroló kérdések (`intake`), Ádám-kvíz (`adamQuiz`), dilemmák, jégtörők, kvízpiramis, felugró üzenetek.
