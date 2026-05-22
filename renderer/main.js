(function () {
  'use strict';

  // ── AG Grid setup ─────────────────────────────────────────────────────────
  let gridApi = null;

  function initGrid(columns, rows) {
    const container = document.getElementById('grid-container');

    const colDefs = columns.map((c, i) => ({
      field: c,
      headerName: c,
      resizable: true,
      sortable: true,
      filter: true,
      minWidth: 80,
      flex: i === 0 ? 0 : 1,
      width: i === 0 ? 120 : undefined,
    }));

    if (gridApi) {
      gridApi.updateGridOptions({ columnDefs: colDefs, rowData: rows });
      return;
    }

    const gridOptions = {
      columnDefs: colDefs,
      rowData: rows,
      defaultColDef: { resizable: true, sortable: true, filter: true },
      rowSelection: 'multiple',
      enableCellTextSelection: true,
      suppressMovableColumns: false,
      suppressFieldDotNotation: true,  // column names like "root.runId" are literal keys, not nested paths
      animateRows: false,              // disable for performance with large sets
      rowBuffer: 20,
    };

    gridApi = agGrid.createGrid(container, gridOptions);
  }

  // ── Monaco Editor setup ───────────────────────────────────────────────────
  let editor = null;

  require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });

  require(['vs/editor/editor.main'], function () {
    // Register custom language
    monaco.languages.register({ id: 'nxql' });

    monaco.languages.setMonarchTokensProvider('nxql', {
      keywords: ['EXTRACT','ROOT','INTO','WHERE','SELECT','AS','WITH','FROM',
                 'JOIN','LEFT','INNER','ON','AND','IN','NOT','XPATH','LIMIT',
                 'ORDER','BY','ASC','DESC'],
      operators: ['=','!=','>','<','>=','<='],
      tokenizer: {
        root: [
          [/--.*$/, 'comment'],
          [/@[\w:-]+/, 'attribute'],
          [/'[^']*'/, 'string'],
          [/\d+(\.\d+)?/, 'number'],
          [/[A-Z_][A-Z0-9_]*/, {
            cases: {
              '@keywords': 'keyword',
              '@default': 'identifier.upper',
            }
          }],
          [/[a-z_]\w*/, 'identifier'],
          [/[\/]+[\w/*[\]@:.-]*/, 'path'],
          [/[=><!]+/, 'operator'],
          [/[(),]/, 'delimiter'],
        ],
      },
    });

    monaco.editor.defineTheme('nxql-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword',          foreground: '569cd6', fontStyle: 'bold' },
        { token: 'attribute',        foreground: '9cdcfe' },
        { token: 'path',             foreground: 'ce9178' },
        { token: 'string',           foreground: 'd69d85' },
        { token: 'number',           foreground: 'b5cea8' },
        { token: 'comment',          foreground: '6a9955', fontStyle: 'italic' },
        { token: 'identifier.upper', foreground: '4fc1ff' },
        { token: 'operator',         foreground: 'd4d4d4' },
      ],
      colors: {
        'editor.background': '#1e1e1e',
      },
    });

    editor = monaco.editor.create(document.getElementById('monaco-container'), {
      language: 'nxql',
      theme: 'nxql-dark',
      value: [
        '-- Write a query below. Press Ctrl+Enter to run.',
        '',
        'EXTRACT',
        '  ROOT  //RootElement         AS root',
        '  INTO  root//ChildElement    AS child',
        '  SELECT root.@id, child.*',
      ].join('\n'),
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'Consolas', 'Courier New', monospace",
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      automaticLayout: true,
      tabSize: 2,
    });

    // Ctrl+Enter to run
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runQuery);

    // Enable run button once editor is ready
    document.getElementById('run-btn').disabled = false;
  });

  // ── State ─────────────────────────────────────────────────────────────────
  let fileLoaded = false;
  let lastResult = null;

  // ── Worker messages ───────────────────────────────────────────────────────
  window.api.onWorkerMessage((msg) => {
    switch (msg.type) {
      case 'progress':
        setStatus(msg.message);
        break;
      case 'fileLoaded':
        fileLoaded = true;
        const mb = (msg.sizeBytes / 1024 / 1024).toFixed(1);
        setStatus(`Loaded — ${mb} MB`);
        document.getElementById('file-path').value = msg.filePath;
        break;
      case 'fileError':
        fileLoaded = false;
        setStatus('Load failed', true);
        showError(msg.message);
        break;
      case 'queryResult':
        lastResult = msg.result;
        showResult(msg.result);
        break;
      case 'queryError':
        showError(msg.error.message);
        setStatus('');
        break;
    }
  });

  // ── File loading ──────────────────────────────────────────────────────────
  document.getElementById('browse-btn').addEventListener('click', async () => {
    const filePath = await window.api.browseFile();
    if (filePath) loadFile(filePath);
  });

  document.getElementById('file-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const p = e.target.value.trim();
      if (p) loadFile(p);
    }
  });

  async function loadFile(filePath) {
    clearError();
    setStatus('Loading…');
    const res = await window.api.loadFile(filePath);
    if (res.error) {
      setStatus('Load failed', true);
      showError(res.error);
    } else if (res.warning) {
      setStatus(res.warning);
    }
  }

  // ── Query execution ───────────────────────────────────────────────────────
  document.getElementById('run-btn').addEventListener('click', runQuery);

  async function runQuery() {
    const query = editor ? editor.getValue().trim() : '';
    if (!query) return;
    clearError();
    setStatus('Running…');
    setBadge('');
    const limitVal = parseInt(document.getElementById('run-limit').value, 10);
    await window.api.runQuery(query, limitVal > 0 ? limitVal : null);
  }

  // ── Results rendering ─────────────────────────────────────────────────────
  function showResult(result) {
    const empty = document.getElementById('empty-state');
    const grid  = document.getElementById('grid-container');

    empty.style.display = 'none';
    grid.style.display = 'block';

    initGrid(result.columns, result.rows);

    const badge = result.truncated
      ? `${result.rows.length.toLocaleString()} of ${result.totalRows.toLocaleString()} rows`
      : `${result.totalRows.toLocaleString()} row${result.totalRows === 1 ? '' : 's'}`;
    setBadge(`${badge} × ${result.columns.length} col${result.columns.length === 1 ? '' : 's'}`);

    document.getElementById('copy-csv-btn').style.display = '';
    document.getElementById('export-csv-btn').style.display = '';
    setStatus('');
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  document.getElementById('copy-csv-btn').addEventListener('click', () => {
    if (lastResult) window.api.copyToClipboard(buildCsv(lastResult));
  });

  document.getElementById('export-csv-btn').addEventListener('click', () => {
    if (lastResult) window.api.exportCsv(buildCsv(lastResult));
  });

  function buildCsv(result) {
    const header = result.columns.map(csvEsc).join(',');
    const lines = [header];
    for (const row of result.rows) {
      lines.push(result.columns.map(c => csvEsc(row[c] ?? '')).join(','));
    }
    return lines.join('\n');
  }

  function csvEsc(v) {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // ── Splitter drag ─────────────────────────────────────────────────────────
  const splitter = document.getElementById('splitter');
  const editorPane = document.getElementById('editor-pane');
  let dragging = false;
  let startY = 0;
  let startH = 0;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = editorPane.offsetHeight;
    splitter.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const newH = Math.max(80, Math.min(startH + delta, window.innerHeight - 200));
    editorPane.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; splitter.classList.remove('dragging'); }
  });

  // ── Sample query click ────────────────────────────────────────────────────
  document.getElementById('empty-state').addEventListener('click', (e) => {
    const sample = e.target.closest('pre.sample');
    if (sample && editor) {
      editor.setValue(sample.textContent.trim());
      editor.focus();
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setStatus(text, isError = false) {
    const el = document.getElementById('file-status');
    el.textContent = text;
    el.style.color = isError ? 'var(--error)' : 'var(--text-dim)';
  }

  function setBadge(text) {
    document.getElementById('result-badge').textContent = text;
  }

  function showError(msg) {
    const bar = document.getElementById('error-bar');
    bar.textContent = msg;
    bar.classList.remove('hidden');
    if (editor) {
      editor.deltaDecorations([], [{
        range: new monaco.Range(1, 1, 1, 1),
        options: {},
      }]);
    }
  }

  function clearError() {
    document.getElementById('error-bar').classList.add('hidden');
  }
})();
