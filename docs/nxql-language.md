# NXQL Language Reference

NXQL (Node XML Query Language) is a SQL-like language for extracting structured data from nested XML files. It describes a traversal path through an XML hierarchy, applies filters at each level, and projects selected attributes into a flat table of rows.

---

## Table of Contents

- [Basic structure](#basic-structure)
- [Step types: ROOT and INTO](#step-types-root-and-into)
- [WHERE filters](#where-filters)
- [SELECT expressions](#select-expressions)
- [Inline lookups](#inline-lookups)
- [LIMIT](#limit)
- [FROM — inline file source](#from--inline-file-source)
- [FROM DIR — directory scan](#from-dir--directory-scan)
- [Comments](#comments)
- [CTEs — WITH … AS](#ctes--with--as)
- [JOIN and LEFT JOIN](#join-and-left-join)
- [Operator reference](#operator-reference)
- [Full examples](#full-examples)

---

## Basic structure

```sql
EXTRACT
  ROOT  //RootTag      AS r
  INTO  r//ChildTag    AS c
  SELECT r.@attr, c.*
LIMIT 1000
```

Every `EXTRACT` query has three sections:

1. **Steps** — one `ROOT` plus zero or more `INTO` clauses that define the traversal path
2. **SELECT** — the columns to include in the output
3. **LIMIT** *(optional)* — cap the number of rows

---

## Step types: ROOT and INTO

### ROOT

```sql
ROOT //TagName AS alias
```

Matches all elements named `TagName` anywhere in the document (a deep descendant search). Each match becomes the starting point for the query's traversal path.

You can use `//*/TagName` — the wildcard is accepted but behaves identically to `//TagName`.

### INTO

```sql
INTO alias//ChildTag AS child_alias
INTO alias//ChildTag AS child_alias WHERE @attr = 'value'
```

Descends into all descendants of the element bound to `alias`, searching for `ChildTag`. Each match is bound to `child_alias` for use in subsequent steps and SELECT expressions.

`INTO` steps can reference any previously bound alias, not just the immediately preceding one:

```sql
EXTRACT
  ROOT  //NetworkBO    AS net
  INTO  net//StationBO AS stn
  INTO  net//RegionBO  AS rgn   -- descends from net, not stn
  SELECT net.@id, stn.@name, rgn.@code
```

---

## WHERE filters

Appended to any `ROOT` or `INTO` step to filter elements before the query descends into them.

```sql
INTO stn//MeasurementBO AS msr WHERE @type = 'WindSpeed'
```

### Supported operators

| Operator | Example | Notes |
|---|---|---|
| `=` | `WHERE @status = 'active'` | String equality |
| `!=` | `WHERE @status != 'closed'` | String inequality |
| `<` | `WHERE @value < 100` | Numeric comparison (parsed as float) |
| `>` | `WHERE @value > 0` | Numeric comparison |
| `<=` | `WHERE @score <= 5.5` | Numeric comparison |
| `>=` | `WHERE @score >= 1.0` | Numeric comparison |
| `IN` | `WHERE @type IN ('A','B','C')` | Matches any value in the list |
| `NOT IN` | `WHERE @type NOT IN ('X','Y')` | Excludes values in the list |

Elements where the filtered attribute is absent are always excluded.

---

## SELECT expressions

### Specific attribute

```sql
SELECT alias.@attributeName
```

Produces a column named `alias.attributeName` (or the alias given with `AS`).

### All attributes (wildcard)

```sql
SELECT alias.*
```

Expands to one column per attribute on the matched element. Column names are `alias.attrName` unless the attribute is renamed with `AS`.

### Renaming columns

```sql
SELECT alias.@attributeName AS myColumn
```

Produces a column named `myColumn` instead of the default `alias.attributeName`.

### Multiple SELECT expressions

Comma-separate them on a single `SELECT` line (or split across lines):

```sql
SELECT
  net.@networkId AS network,
  stn.@stationId AS station,
  msr.*
```

---

## Inline lookups

An inline lookup pulls a value from a side-branch descendant and adds it as a column on the current row — without adding a new traversal level.

```sql
alias//TagName WHERE @attr = 'value' RETURN @returnAttr AS columnName
```

This is placed inside a `SELECT` expression list:

```sql
SELECT
  stn.@stationId,
  stn//PropertyBO WHERE @type = 'Elevation'  RETURN @value AS elevation,
  stn//PropertyBO WHERE @type = 'StationClass' RETURN @intValue AS stationClass,
  msr.*
```

If multiple elements match the lookup path, the first match is used. If no match, the column value is empty.

---

## LIMIT

```sql
LIMIT 5000
```

Caps the total number of rows returned. The query stops traversing as soon as the limit is reached. If omitted, all rows are returned.

The UI toolbar also has a **Limit** dropdown that applies independently — whichever is smaller wins.

---

## FROM — inline file source

Load and query a specific XML file directly in the query, without using the browse button.

```sql
EXTRACT FROM 'C:/data/observations.xml'
  ROOT //StationBO AS stn
  SELECT stn.*
LIMIT 500
```

- The path can use forward slashes (`/`) or backslashes (`\`)
- Single quotes are required
- The file is cached after the first run — subsequent runs with the same path do not re-read from disk

---

## FROM DIR — directory scan

Run the same query against every `*.xml` file in a directory. Results are unioned into a single table, and a `_source` column is prepended showing the filename (not the full path) each row came from.

```sql
EXTRACT FROM DIR 'C:/data/archive/2024/'
  ROOT //StationBO AS stn
  INTO stn//MeasurementBO AS msr
  SELECT stn.@stationId, msr.*
LIMIT 2000
```

Files are processed in alphabetical order. The limit applies across all files combined.

`FROM DIR` is not supported inside a CTE — use a standalone `EXTRACT` for directory queries.

---

## Comments

Single-line comments start with `--` and run to the end of the line:

```sql
-- This extracts wind speed measurements
EXTRACT FROM 'C:/data/obs.xml'
  ROOT //StationBO AS stn  -- each station
  INTO stn//MeasurementBO AS msr WHERE @type = 'WindSpeed'
  SELECT stn.@id, msr.*
```

---

## CTEs — WITH … AS

Named subqueries (Common Table Expressions) let you define multiple flat tables and then join them.

```sql
WITH name AS (
  EXTRACT
    ROOT ...
    INTO ...
    SELECT ...
),
another AS (
  EXTRACT ...
)
SELECT ...
FROM name AS n
JOIN another AS a ON n.col = a.col
```

Each CTE runs its own `EXTRACT` query (optionally with its own `FROM 'path'`). The final `SELECT` references the CTE names and joins them.

---

## JOIN and LEFT JOIN

After the CTE definitions, a final `SELECT … FROM … JOIN` assembles the result.

```sql
SELECT w.networkId, w.stationId, w.period, w.windSpeed, t.temperature
FROM wind AS w
LEFT JOIN temperature AS t ON w.networkId = t.networkId
                          AND w.stationId = t.stationId
                          AND w.period    = t.period
LIMIT 500
```

- `JOIN` (inner join) — only rows with a match on both sides are returned
- `LEFT JOIN` — all rows from the left table are returned; unmatched right-side columns are empty
- Multiple `ON` conditions are combined with `AND`
- Column references in `ON` use `alias.columnName`

---

## Operator reference

| Operator | Type | Example |
|---|---|---|
| `=` | Equality | `@status = 'active'` |
| `!=` | Inequality | `@type != 'Draft'` |
| `<` | Less than (numeric) | `@value < 100` |
| `>` | Greater than (numeric) | `@value > 0` |
| `<=` | Less than or equal | `@score <= 5.5` |
| `>=` | Greater than or equal | `@count >= 1` |
| `IN` | Set membership | `@code IN ('A','B','C')` |
| `NOT IN` | Set exclusion | `@code NOT IN ('X','Y')` |

---

## Full examples

### Basic extraction

```sql
EXTRACT
  ROOT  //ObservationNetworkBO    AS net
  INTO  net//WeatherStationBO     AS stn
  INTO  stn//ObservationPeriodBO  AS pd
  INTO  pd//MeasurementBO         AS msr
  SELECT net.@networkId, net.@region, stn.@stationId, pd.@startDate, msr.*
LIMIT 500
```

### Inline source with filters and lookups

```sql
EXTRACT FROM 'C:/data/observations-2024.xml'
  ROOT  //ObservationNetworkBO AS net
  INTO  net//WeatherStationBO AS stn
  INTO  stn//ObservationPeriodBO AS pd
  INTO  pd//MeasurementGroupBO AS mg  WHERE @groupType = 'Atmospheric'
  INTO  mg//MeasurementBO AS msr      WHERE @measurementType IN ('WindSpeed','Pressure')
  SELECT
    net.@networkId,
    stn.@stationId,
    pd.@startDate,
    mg//PropertyBO WHERE @propertyType = 'StationClass'  RETURN @value        AS stationClass,
    mg//PropertyBO WHERE @propertyType = 'CalibrationId' RETURN @integerValue AS calibrationId,
    msr.*
LIMIT 1000
```

### Directory scan

```sql
EXTRACT FROM DIR 'C:/data/archive/2024/'
  ROOT  //ObservationNetworkBO AS net
  INTO  net//WeatherStationBO AS stn
  INTO  stn//MeasurementBO AS msr
  SELECT net.@networkId, stn.@stationId, msr.*
LIMIT 2000
```

### CTE + LEFT JOIN

```sql
WITH wind AS (
  EXTRACT
    ROOT  //ObservationNetworkBO AS net
    INTO  net//WeatherStationBO AS stn
    INTO  stn//ObservationPeriodBO AS pd
    INTO  pd//MeasurementGroupBO AS mg   WHERE @groupType = 'Atmospheric'
    INTO  mg//MeasurementBO AS msr       WHERE @measurementType = 'WindSpeed'
    SELECT net.@networkId AS networkId, stn.@stationId AS stationId,
           pd.@startDate AS period, msr.@value AS windSpeed, msr.@unit AS windUnit
),
temperature AS (
  EXTRACT
    ROOT  //ObservationNetworkBO AS net
    INTO  net//WeatherStationBO AS stn
    INTO  stn//ObservationPeriodBO AS pd
    INTO  pd//MeasurementGroupBO AS mg   WHERE @groupType = 'Atmospheric'
    INTO  mg//MeasurementBO AS msr       WHERE @measurementType = 'Temperature'
    SELECT net.@networkId AS networkId, stn.@stationId AS stationId,
           pd.@startDate AS period, msr.@value AS temperature, msr.@unit AS tempUnit
)
SELECT w.networkId, w.stationId, w.period, w.windSpeed, t.temperature
FROM wind AS w
LEFT JOIN temperature AS t ON w.networkId = t.networkId
                          AND w.stationId = t.stationId
                          AND w.period    = t.period
LIMIT 500
```
