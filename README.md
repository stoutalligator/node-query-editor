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
| `WHERE @attr = 'value'` | Filter a step — supports `=` `!=` `<` `>` `>=` `<=` `IN(…)` `NOT IN(…)` |
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

### CTEs and JOINs

```sql
WITH a AS (EXTRACT ROOT //Foo AS f SELECT f.*),
     b AS (EXTRACT ROOT //Bar AS b SELECT b.*)
SELECT a.id, b.value
FROM a AS a
LEFT JOIN b AS b ON a.id = b.id
```

See [docs/nxql-language.md](docs/nxql-language.md) for the complete language reference with worked examples.

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
