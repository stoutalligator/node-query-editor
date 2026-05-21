# Node Query Editor

A desktop SQL editor for large XML files. Write NXQL queries, see flat table results, export to CSV. Never touch the raw XML.

Built with Electron + TypeScript. Handles files up to 1 GB+ without freezing the UI by running all parsing and query evaluation in a worker thread.

---

## The Problem

Pricing engine XML output files can be 100 MB–1 GB+. Standard tools choke on them. Opening them in a text editor is useless. XPath tools return raw node dumps. This app lets you query them like a database.

---

## NXQL — The Query Language

**NXQL** (Node XML Query Language) is a SQL-like language for navigating and extracting from nested XML trees. You describe a traversal path through the hierarchy, add filters, and select which attributes become columns.

### Simple extraction

```sql
EXTRACT
  ROOT  //*/ClaimGroupBO                        AS cg
  INTO  cg//ClaimPeriodBO                       AS cp
  INTO  cp//PropertyGroupBO/PropertyGroupBO     AS pg
  INTO  pg//RateComponentVectorBO               AS rcv WHERE @rateComponentType IN ('FIRE','WIND')
  INTO  rcv//RateDetailBO                       AS rd
  SELECT cg.@policyNumber, cp.@startDate, cp.@endDate, pg.@propertyId, rd.*
```

- `ROOT` — starting path, bound to an alias
- `INTO alias//Tag AS alias` — descend into children, bind a new alias
- `WHERE @attr IN ('a','b')` — filter at that level before descending; supports `=`, `!=`, `>`, `<`, `>=`, `<=`, `IN`, `NOT IN`
- `SELECT alias.@attr` — pick specific attributes as columns
- `alias.*` — expand to all attributes on that node (prefixed as `alias.attrName`)
- `LIMIT 5000` — cap result rows

### CTE + LEFT JOIN

```sql
WITH fire AS (
  EXTRACT
    ROOT  //*/ClaimGroupBO                    AS cg
    INTO  cg//ClaimPeriodBO                   AS cp
    INTO  cp//PropertyGroupBO/PropertyGroupBO AS pg
    INTO  pg//RateComponentVectorBO           AS rcv WHERE @rateComponentType = 'FIRE'
    INTO  rcv//RateDetailBO                   AS rd
    SELECT cg.@policyNumber AS policyNumber, pg.@propertyId AS propertyId,
           rd.@rateFactor AS fireFactor
),
wind AS (
  EXTRACT
    ROOT  //*/ClaimGroupBO                    AS cg
    INTO  cg//ClaimPeriodBO                   AS cp
    INTO  cp//PropertyGroupBO/PropertyGroupBO AS pg
    INTO  pg//RateComponentVectorBO           AS rcv WHERE @rateComponentType = 'WIND'
    INTO  rcv//RateDetailBO                   AS rd
    SELECT cg.@policyNumber AS policyNumber, pg.@propertyId AS propertyId,
           rd.@rateFactor AS windFactor
)

SELECT f.policyNumber, f.propertyId, f.fireFactor, w.windFactor
FROM fire f
LEFT JOIN wind w ON f.policyNumber = w.policyNumber
               AND f.propertyId    = w.propertyId
```

Each CTE produces a flat table. The final `SELECT` joins them. `LEFT JOIN` preserves rows with no match on the right side.

### Raw XPath

```sql
XPATH //*/ClaimPeriodBO/@startDate
```

Passes the expression directly to an XPath evaluator and returns raw results. Useful for quick attribute dumps.

### Comments

```sql
-- This is a comment
EXTRACT ...
```

---

## Architecture

```
src/
  main.ts              Electron main: window, IPC, file dialog, CSV save
  preload.ts           contextBridge — exposes window.api.* to renderer
  worker.ts            worker_thread entry: handles loadFile + runQuery
  query-engine/
    types.ts           Interfaces: ParsedQuery, ResultRow, WorkerInMessage, etc.
    parser.ts          NXQL tokenizer + recursive descent parser → ParsedQuery
    evaluator.ts       Executes ParsedQuery against htmlparser2 DOM tree
renderer/
  index.html           App shell (Monaco + AG Grid)
  main.js              UI: file bar, Monaco editor, AG Grid results, CSV export
  styles.css           Dark theme, splitter, AG Grid overrides
esbuild.js             Builds src/ → dist/
```

### Message flow

```
[Renderer]                            [Main]                  [Worker]
   |─── api.loadFile(path) ─────────>|─── postMessage ──────>|
   |<── onWorkerMessage(progress) ────|<── parentPort.post ───|
   |<── onWorkerMessage(fileLoaded) ──|                       |
   |─── api.runQuery(nxql, limit) ──>|─── postMessage ──────>|
   |<── onWorkerMessage(queryResult)─ |<── parentPort.post ───|
```

---

## Setup

```bash
npm install
npm run compile   # builds dist/main.js, dist/preload.js, dist/worker.js
npm start         # compile + launch
```

### Package for distribution

```bash
npm run package   # outputs installer to release/
```

---

## Status

| Feature | Status |
|---|---|
| EXTRACT queries | Working |
| CTE + LEFT JOIN | Working |
| WHERE filters | Working |
| CSV copy + export | Working |
| Monaco NXQL syntax highlighting | Working |
| AG Grid virtual scroll (1M+ rows) | Working |
| XPATH mode | Wired, evaluator not yet implemented |
| Monaco autocomplete for tag names | Planned |
| Monaco error squiggles | Planned |
| Auto-update (electron-updater) | Planned |
