# Node Query Editor

A desktop app for querying large XML files with SQL-like syntax. Write NXQL queries, explore nested data as flat tables, and export to CSV — without ever touching raw XML.

Built with Electron. Handles files up to 1 GB+ by running all parsing in a background worker thread, keeping the UI responsive at all times.

---

## Download

Download the latest Windows installer from the [Releases page](https://github.com/stoutalligator/node-query-editor/releases).

Run `NodeQueryEditor-Setup-x.x.x.exe` and follow the prompts. The app will notify you when a new version is available and let you install it in one click.

---

## Quick Start

1. **Open a file** — click **Open File** or paste a path and press Enter
2. **Write a query** — use the editor (NXQL syntax highlighted)
3. **Run** — press `Ctrl+Enter` or click **Run**
4. **Export** — use **Copy CSV** or **Export CSV** to save results

You can also reference XML files directly in a query without using the browse button:

```sql
EXTRACT FROM 'C:/data/observations.xml'
  ROOT //WeatherStationBO AS stn
  SELECT stn.*
LIMIT 500
```

---

## NXQL Language

NXQL (Node XML Query Language) is a SQL-like language for navigating nested XML trees and extracting data as flat rows.

### Core syntax

| Keyword | Description |
|---|---|
| `EXTRACT` | Start a query block |
| `ROOT //Tag AS alias` | Match all elements named `Tag` anywhere in the document |
| `INTO alias//Tag AS alias` | Descend into descendants of the previous alias |
| `WHERE @attr = 'value'` | Filter a step — supports `=` `!=` `<` `>` `>=` `<=` `IN(…)` `NOT IN(…)`, and compound `AND` / `OR` |
| `SELECT alias.@attr` | Select a specific attribute |
| `SELECT alias.*` | Select all attributes from a step |
| `LIMIT n` | Cap the number of rows returned |
| `-- comment` | Single-line comment |

### Inline file source

```sql
EXTRACT FROM 'C:/path/to/file.xml'
  ROOT //SomeTag AS t SELECT t.*
```

### Directory scan

Run the same query against every `*.xml` in a folder. Results are unioned and a `_source` column shows which file each row came from.

```sql
EXTRACT FROM DIR 'C:/data/archive/'
  ROOT //SomeTag AS t SELECT t.*
LIMIT 2000
```

### Inline lookups

Pull a value from a side-branch element per row:

```sql
alias//PropertyBO WHERE @type = 'Label' RETURN @value AS label
```

### Compound WHERE (AND / OR)

Conditions can be chained with `AND` and `OR`. Standard SQL precedence applies — `AND` binds tighter than `OR`.

```sql
-- OR across different attributes
EXTRACT ROOT //*/RateComponentVectorBO AS rcv
WHERE @rateComponentType = 'FIRE' OR @rateComponentType = 'WIND'
SELECT rcv.*

-- AND — all conditions must pass
EXTRACT ROOT //*/PolicyBO AS p
WHERE @status = 'Active' AND @type = 'Standard'
SELECT p.*

-- Mixed — AND is evaluated before OR
-- Reads as: (@type = 'FIRE' AND @tier = '1') OR @override = 'true'
EXTRACT ROOT //*/RateComponentVectorBO AS rcv
WHERE @type = 'FIRE' AND @tier = '1' OR @override = 'true'
SELECT rcv.*

-- IN / NOT IN compose freely with AND / OR
EXTRACT ROOT //*/RateDetailBO AS rd
WHERE @rateType IN ('BASE', 'ADJ') AND @active != 'false'
SELECT rd.*
```

### CTEs, JOINs, and GROUP BY

Named subqueries (CTEs) let you build a table from one or more `EXTRACT` blocks and then join or aggregate them.

```sql
WITH a AS (EXTRACT ROOT //Foo AS f SELECT f.*),
     b AS (EXTRACT ROOT //Bar AS b SELECT b.*)
SELECT a.id, b.value
FROM a AS a
LEFT JOIN b AS b ON a.id = b.id
```

`FROM DIR` is supported inside CTEs, enabling multi-file aggregation:

```sql
WITH base AS (
  EXTRACT FROM DIR 'C:/data/archive/'
    ROOT //SimulationBatchBO AS sb SELECT sb.batchId, sb.cohortId
)
SELECT sb.batchId, sb.cohortId, COUNT(*) AS count
FROM base AS b
GROUP BY sb.batchId, sb.cohortId
HAVING COUNT(*) > 1
```

`GROUP BY` groups rows by the listed columns. `HAVING COUNT(*) op n` filters groups — use `> 1` to find duplicates.

See [docs/nxql-language.md](docs/nxql-language.md) for the complete language reference with worked examples.

---

## Saved Queries

Click **Save** in the editor header to name and save the current query. Click **Saved ▾** to open a panel listing all saved queries — click **Load** to restore one to the editor, or **✕** to delete it. Saved queries persist across app restarts.

---

## CLI Usage

The query engine can be used headlessly from the command line or called programmatically from another application. This is useful for automating queries, running scheduled extracts, or integrating with tools written in other languages.

### Install

**Prerequisites:** Node.js 20+

Clone the repo and build:

```bash
git clone https://github.com/stoutalligator/node-query-editor.git
cd node-query-editor
npm install
npm run compile
```

To make the `node-extract` command available globally:

```bash
npm install -g .
```

Or reference `dist/cli.js` directly using `node dist/cli.js` without installing globally.

---

### How it works

The CLI reads a JSON batch spec from **stdin** and writes results to **stdout** as JSON. You pass either an `xmlFile` (single file) or `xmlDir` (directory of XML files), plus a list of named queries. All queries run against the same loaded source — the XML is parsed once regardless of how many queries you run.

**Batch spec format:**

```json
{
  "xmlFile": "C:/data/prices.xml",
  "queries": [
    { "name": "items",  "query": "EXTRACT Item ROOT /PriceList FROM '{xmlFile}' SELECT @id, @price" },
    { "name": "promos", "query": "EXTRACT Promo ROOT /Promos FROM '{xmlFile}' SELECT @id, @active" }
  ]
}
```

Use `{xmlFile}` or `{xmlDir}` as placeholders in query strings — the CLI substitutes the actual path before parsing. Provide `xmlFile` **or** `xmlDir`, not both.

**For a directory of XML files** — results are unioned and a `_source` column is added showing which file each row came from:

```json
{
  "xmlDir": "C:/data/monthly/",
  "queries": [
    { "name": "items", "query": "EXTRACT Item ROOT /PriceList FROM DIR '{xmlDir}' SELECT @id, @price" }
  ]
}
```

**Response format:**

```json
{
  "items":  { "columns": ["id", "price"], "rows": [{ "id": "1", "price": "9.99" }], "totalRows": 1, "truncated": false },
  "promos": { "columns": ["id", "active"], "rows": [...], "totalRows": 42, "truncated": false }
}
```

Individual query failures return an `error` key for that result without affecting the rest of the batch:

```json
{
  "items":  { "columns": [...], "rows": [...], "totalRows": 10, "truncated": false },
  "broken": { "error": "Unexpected token at position 12" }
}
```

---

### Calling from another application

**Python example** — runs a batch and loads each result into a pandas DataFrame:

```python
import subprocess, json
import pandas as pd

spec = {
    "xmlDir": "C:/data/monthly/",
    "queries": [
        {"name": "items",  "query": "EXTRACT Item ROOT /PriceList FROM DIR '{xmlDir}' SELECT @id, @price"},
        {"name": "promos", "query": "EXTRACT Promo ROOT /Promos FROM DIR '{xmlDir}' SELECT @id, @active"},
    ]
}

result = subprocess.run(
    ["node", "C:/path/to/node-query-editor/dist/cli.js"],
    input=json.dumps(spec),
    capture_output=True,
    text=True
)

if result.returncode != 0:
    raise RuntimeError(result.stderr)

results = json.loads(result.stdout)

# Load successful results into DataFrames, skip any that errored
dfs = {}
for name, data in results.items():
    if "error" in data:
        print(f"Query '{name}' failed: {data['error']}")
    else:
        dfs[name] = pd.DataFrame(data["rows"])

# Use like: dfs["items"], dfs["promos"]
```

If `node-extract` is installed globally (`npm install -g .`), replace the `node dist/cli.js` path with just `"node-extract"`:

```python
result = subprocess.run(
    ["node-extract"],
    input=json.dumps(spec),
    capture_output=True,
    text=True
)
```

---

## Building from Source

**Prerequisites:** Node.js 20+

```bash
git clone https://github.com/stoutalligator/node-query-editor.git
cd node-query-editor
npm install
npm run compile   # builds dist/
npm start         # launch the app
```

To package a Windows installer locally:

```bash
npm run package   # outputs to release/
```

See [docs/development.md](docs/development.md) for the full developer guide including branch strategy and how to cut a release.
