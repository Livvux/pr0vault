# AGENTS.md — pr0Vault

Repo-Kontext für AI-Coding-Agents (Claude Code, OpenCode, Cursor, etc.).
Menschen lesen `README.md`.

## Was ist das

Chrome MV3 Extension. Spiegelt die eigenen pr0gramm.com-Inhalte (Uploads,
Kommentare, Sammlungen, Inbox, Filter) lokal in IndexedDB. Lokal-only,
kein Backend.

## Tech-Stack

- **Build**: Vite (zwei Configs: `vite.config.ts` für popup/background/options,
  `vite.content.config.ts` separat für das Content-Script — IIFE-Bundle nötig
  wegen MV3-Injection)
- **UI**: Preact + `@preact/signals`
- **DB**: Dexie.js (IndexedDB-Wrapper)
- **Search**: Fuse.js
- **Export**: JSZip (statisch importiert — siehe Service-Worker-Quirks unten)
- **Package-Manager**: `pnpm` (immer, nie npm/yarn)
- **TypeScript**: strict mode

## Commands

```sh
pnpm install
pnpm run build          # Production-Build → dist/
pnpm run dev            # Watch-Mode (build + content parallel)
pnpm run build:icons    # Icons aus SVG/Source generieren (läuft auto via prebuild)
pnpm run release minor  # Version bumpen + taggen (siehe Release-Workflow)
```

Laden in Chrome: `chrome://extensions` → Entwicklermodus → "Entpackte
Erweiterung laden" → `dist/` auswählen.

## Architektur

```
src/
├── background.ts         # Service Worker: API-Sync, Message-Router, Search, Export
├── content.ts            # Auf pr0gramm.com: fetch-Wrapper für passives Mit-Loggen
├── popup/                # Preact UI (Dashboard, Search, Export, Sammlungen, Log)
│   ├── App.tsx
│   ├── Collections.tsx   # Sammlungen-Tab (Liste + Detail-Grid)
│   ├── Dashboard.tsx
│   ├── Export.tsx
│   ├── Log.tsx
│   ├── Search.tsx
│   └── styles.css
├── options/              # Settings-Page (Akzentfarbe, Auto-Sync, ...)
└── shared/
    ├── db.ts             # Dexie-Schema
    ├── logger.ts         # In chrome.storage.local, max 200 entries
    ├── messages.ts       # Message-Protokoll (typed)
    └── types.ts          # Upload, Comment, Collection, CollectionItem, ...
```

**Datenfluss Sync:** Popup → `chrome.runtime.sendMessage({type:'SYNC_START',scope})`
→ `background.ts` ruft pr0gramm-API (mit Cookies aus `chrome.cookies`) →
schreibt Dexie → broadcastet `SYNC_PROGRESS`/`SYNC_COMPLETE` an alle Listener.

**Datenfluss Passive Sync:** Content-Script auf pr0gramm.com überschreibt
`window.fetch` und schickt API-Responses an Service Worker → `STORE_BATCH`.

## Release-Workflow (automatisiert)

**TL;DR:**
```sh
pnpm release minor              # 0.2.0 → 0.3.0
git push origin main --follow-tags
```
→ GitHub Action baut, zipt, erstellt Release. Fertig.

### Details

1. **`pnpm release <bump>`** ruft `scripts/release.mjs`:
   - Bumpt `package.json` UND `manifest.json` synchron auf neue Version
     (`patch` | `minor` | `major` | explizit `x.y.z`)
   - Committet beide Files: `chore(release): vX.Y.Z`
   - Erstellt annotierten Tag `vX.Y.Z`
   - Verlangt sauberen Working-Tree

2. **`git push --follow-tags`** pusht Commit + Tag.

3. **GitHub Action `.github/workflows/release.yml`** triggert auf `v*` Tag:
   - Verifiziert dass Tag == `package.json` == `manifest.json` (sonst Fail)
   - `pnpm install --frozen-lockfile` + `pnpm build`
   - Zipt `dist/` → `release/pr0vault-vX.Y.Z.zip`
   - Generiert Changelog aus `git log <prev_tag>..<this_tag>`
   - `gh release create` mit ZIP als Asset

4. **Chrome Web Store** bleibt manuell — Google verlangt Human-Review-
   Submission. ZIP ist direkt aus dem GitHub Release nutzbar.

### Versions-Konvention

`package.json` und `manifest.json` müssen IMMER identische Versionen haben.
Das Release-Script bumpt beide. Wenn du manuell bumpst: beide ändern, sonst
schlägt der Action-Verify-Step fehl.

## pr0gramm-API-Quirks (hart erarbeitet)

- **`/api/items/get?collection=KEYWORD` ohne `user=` Param** liefert Items
  aus **fremden** Public-Collections mit dem gleichen Keyword (z. B.
  ~55.000 fremde "favoriten" weltweit). **Immer `user=<me>` mitschicken**
  wenn man eigene Collection-Items will. Siehe `syncCollectionItems`.

- **`/api/profile/comments` Pagination**: `before=<ts>` für ältere,
  `after=<ts>` für neuere. State (`before`/`after`) muss **außerhalb** der
  while-Loop leben, sonst wird Page 1 endlos neu geholt.

- **`/api/inbox/pending`** = nur ungelesene Messages, **kein mark-as-read
  Side-Effect** (soweit wir wissen). Das ist der einzige Endpoint, den der
  Backup nutzen DARF.
- **`/api/inbox/all`** = listet ALLE Messages (gelesen + ungelesen) —
  hat aber einen **kritischen Side-Effect**: jeder Call markiert die
  zurückgegebenen Messages als gelesen. Live verifiziert: 2 unread
  → 0 unread nach einem `/inbox/all` Call. Für ein Backup-Tool ist das
  inakzeptabel (User verliert den unread-Badge). Auch `markAsRead=false`
  und andere Param-Kombinationen existieren nicht als Opt-out.
- **Konsequenz für DSGVO-Export**: Wir sichern nur die ungelesenen
  Messages. Nach dem ersten Sync werden sie vom User in der pr0gramm-UI
  ohnehin als gelesen markiert; ein zweiter Sync findet sie nicht mehr
  (sind in der DB aber nicht re-fetchable). Es gibt **keinen** pr0gramm-
  Endpoint, der die vollständige Histothek ohne Side-Effect liefert.

- **`/api/collections/get`** liefert `isPublic`/`isDefault` als `0|1`
  (number), nicht boolean. `isCurated` fehlt — manuell `false` setzen.
  Curated-Collections kommen in `curatorCollections` (oder
  `curatedCollections` — beide Keys möglich).

- **Cookies**: `pp` und `me` sind die Auth-Cookies. `me` ist URL-encoded
  JSON mit u. a. `n` (username), `id`, `paid`.

- **Throttle**: 300 ms zwischen Pagination-Calls. pr0gramm-API ist nicht
  öffentlich dokumentiert, aber rate-limited.

## Service-Worker-Quirks (MV3)

- **`URL.createObjectURL` existiert NICHT im SW**. Für Downloads stattdessen
  `data:` URLs bauen — für JSON `encodeURIComponent`, für Binär `JSZip`
  mit `type: "base64"` und `data:application/zip;base64,<...>`.

- **`window` existiert nicht im SW**. Daher JSZip **statisch** importieren
  (`import JSZip from "jszip"`) — der dynamische `import()` zieht Vites
  Preload-Helper rein, dessen Error-Path `window.dispatchEvent` aufruft
  → Crash.

- **SW schläft nach ~30s Idle**. Lange Syncs überleben weil sie awaited
  werden (Chrome hält SW während Promises). Aber: `chrome.alarms` für
  Auto-Sync nutzen, niemals `setInterval`.

- **`chrome.runtime.sendMessage` aus dem SW** geht nicht zurück an den SW
  selbst — nur an Popup/Content-Script/Options. Wenn man einen Sync aus
  einer Test-Eval triggern will: aus dem Popup-Context senden.

## Debugging

Logs landen in `chrome.storage.local` unter `pr0vault_logs` (max 200
Einträge, ringbuffer). Im Popup → Tab "Log" sichtbar.

CDP-Port-Debugging:
```sh
curl http://localhost:9222/json/list   # findet Service-Worker-ID
```
Mit der ID via WebSocket evaluieren — sehr nützlich für IndexedDB-
Inspection und Live-Sync-Beobachtung.

## Konventionen

- **Keine Kommentare hinzufügen**, außer der User bittet darum.
- **pnpm**, nie npm.
- **TypeScript strict**, `any` vermeiden (in `syncCollectionItems` ein paar
  bewusste `any` für pr0gramm-API-Roh-Objekte).
- Deutsche UI-Texte, englische Code-Kommentare und Commit-Messages.
- **Niemals** committen ohne Verifikation (Build muss durchlaufen).
- **Niemals** Release-Tag pushen wenn `pnpm build` lokal failed.
