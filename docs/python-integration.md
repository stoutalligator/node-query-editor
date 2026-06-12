# Python Integration Guide

This guide covers how to call the NXQL query engine from a Python application.

## 1. Add as a dependency

In your app's `package.json` (wherever it lives alongside your `node_modules`):

```json
"dependencies": {
  "node-extract-app": "github:stoutalligator/node-query-editor"
}
```

Run `npm install` — the CLI binary will land at:
```
node_modules/.bin/node-extract
```

---

## 2. Python wrapper

Drop this wherever makes sense in your project. Adjust `NODE_MODULES_BIN` to match
the path to `node_modules/.bin` relative to this file.

```python
import subprocess
import json
import shutil
from pathlib import Path
import pandas as pd

# Adjust this path to point at your node_modules/.bin
NODE_MODULES_BIN = Path(__file__).parent / "path" / "to" / "node_modules" / ".bin"


def query_xml(
    queries: dict[str, str],
    *,
    xml_file: str | None = None,
    xml_dir: str | None = None,
) -> dict[str, pd.DataFrame]:
    """
    Run one or more NXQL queries against an XML file or directory.

    Parameters
    ----------
    queries : dict[str, str]
        Mapping of result name -> NXQL query string.
        e.g. {"prices": "SELECT @id, @price FROM //Item"}
    xml_file : str, optional
        Path to a single XML file.
    xml_dir : str, optional
        Path to a directory of XML files. Adds a '_source' column
        with the filename each row came from.

    Returns
    -------
    dict[str, pd.DataFrame]
        One DataFrame per query name.
        If a query fails, its DataFrame has a single 'error' column.

    Raises
    ------
    ValueError
        If neither xml_file nor xml_dir is provided.
    RuntimeError
        If the node process itself fails (bad install, missing binary, etc).
    """
    if not xml_file and not xml_dir:
        raise ValueError("Provide xml_file or xml_dir")

    payload = {
        "queries": [{"name": k, "query": v} for k, v in queries.items()]
    }
    if xml_file:
        payload["xmlFile"] = str(xml_file)
    if xml_dir:
        payload["xmlDir"] = str(xml_dir)

    binary = NODE_MODULES_BIN / "node-extract"
    node = shutil.which("node")

    # On Windows the bin entry is a .cmd shim — fall back to calling node directly
    if not binary.exists():
        cli = NODE_MODULES_BIN.parent / "node-extract-app" / "dist" / "cli.js"
        cmd = [node, str(cli)]
    else:
        cmd = [str(binary)]

    result = subprocess.run(
        cmd,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())

    raw: dict = json.loads(result.stdout)

    frames = {}
    for name, data in raw.items():
        if "error" in data:
            frames[name] = pd.DataFrame([{"error": data["error"]}])
        else:
            frames[name] = pd.DataFrame(data["rows"], columns=data["columns"])

    return frames
```

---

## 3. Usage examples

### Single file, single query
```python
dfs = query_xml(
    {"active_items": "SELECT @id, @price FROM //Item WHERE @active = 'true'"},
    xml_file="C:/data/catalog.xml"
)
df = dfs["active_items"]
```

### Single file, multiple queries
```python
dfs = query_xml(
    {
        "items":      "SELECT @id, @price FROM //Item",
        "categories": "SELECT @name, @code FROM //Category",
    },
    xml_file="C:/data/catalog.xml"
)
```

### Directory of XML files
```python
# Adds a '_source' column containing the filename each row came from
dfs = query_xml(
    {"all_items": "SELECT @id, @price FROM //Item"},
    xml_dir="C:/data/xml-exports/"
)
```

### Limit rows
```python
dfs = query_xml(
    {"sample": "SELECT @id FROM //Item LIMIT 100"},
    xml_file="C:/data/catalog.xml"
)
```

---

## 4. Input payload reference

The CLI accepts JSON on stdin:

```json
{
  "xmlFile": "C:/path/to/file.xml",
  "queries": [
    { "name": "result_name", "query": "SELECT @id FROM //Item" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `xmlFile` | string | Path to a single XML file. Use this OR `xmlDir`. |
| `xmlDir` | string | Path to a directory — all `.xml` files are queried in sorted order. |
| `queries` | array | At least one `{ name, query }` object required. |

---

## 5. Output reference

The CLI writes JSON to stdout:

```json
{
  "result_name": {
    "columns": ["id", "price"],
    "rows": [{ "id": "123", "price": "9.99" }],
    "totalRows": 1,
    "truncated": false
  }
}
```

On a per-query error:
```json
{
  "result_name": { "error": "Unexpected token at position 4" }
}
```

`truncated: true` means a `LIMIT` was hit — there are more rows in the source data.

---

## 6. Keeping the CLI up to date

When this repo is updated, re-run `npm install` in your app to pull the latest.
The compiled `dist/cli.js` is committed to this repo, so no build step is needed.
