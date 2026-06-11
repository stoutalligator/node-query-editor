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
                 'ORDER','BY','ASC','DESC','RETURN','DIR'],
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
          [/dataset:[A-Za-z0-9_-]+/, 'dataset-ref'],
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
        { token: 'dataset-ref',      foreground: '4ec994', fontStyle: 'bold' },
      ],
      colors: {
        'editor.background': '#21222c',
        'editor.lineHighlightBackground': '#2a2b36',
        'editorGutter.background': '#1e1f29',
        'editorLineNumber.foreground': '#44475a',
        'editorLineNumber.activeForeground': '#8b949e',
      },
    });

    editor = monaco.editor.create(document.getElementById('monaco-container'), {
      language: 'nxql',
      theme: 'nxql-dark',
      value: [
        '-- Write a query below. Press Ctrl+Enter to run.',
        '-- Click any example in the panel below to load it, or use FROM to specify an XML file.',
        '',
        'EXTRACT',
        '  ROOT  //ObservationNetworkBO    AS net',
        '  INTO  net//WeatherStationBO     AS stn',
        '  INTO  stn//MeasurementBO        AS msr',
        '  SELECT net.@region, stn.@stationId, msr.*',
        'LIMIT 1000',
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

    // dataset: autocomplete
    monaco.languages.registerCompletionItemProvider('nxql', {
      triggerCharacters: [':'],
      provideCompletionItems(model, position) {
        const textBefore = model.getLineContent(position.lineNumber).substring(0, position.column - 1);
        if (!textBefore.endsWith('dataset:')) return { suggestions: [] };
        return {
          suggestions: dccDatasets.map(ds => ({
            label: ds.name,
            kind: monaco.languages.CompletionItemKind.Value,
            insertText: ds.name,
            detail: ds.query ? ds.query.slice(0, 80) : '(file dataset)',
          })),
        };
      },
    });

    // Enable run button once editor is ready
    document.getElementById('run-btn').disabled = false;
  });

  // ── State ─────────────────────────────────────────────────────────────────
  let fileLoaded = false;
  let lastResult = null;
  let lastQueryText = '';

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
      case 'xmlExportDone':
        setStatus('XML exported');
        break;
      case 'xmlExportError':
        showError(msg.message);
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
    lastQueryText = query;
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

    // Show XML export only for EXTRACT queries (not CTEs / WITH)
    const isExtract = lastQueryText.trimStart().toUpperCase().startsWith('EXTRACT');
    document.getElementById('xml-export-wrap').style.display = isExtract ? '' : 'none';

    setStatus('');
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  document.getElementById('copy-csv-btn').addEventListener('click', () => {
    if (lastResult) window.api.copyToClipboard(buildCsv(lastResult));
  });

  document.getElementById('export-csv-btn').addEventListener('click', async () => {
    if (!lastResult) return;
    setStatus('Exporting…');
    const { saved } = await window.api.exportCsv(buildCsv(lastResult));
    if (saved) {
      setStatus('CSV saved', false, true);
      setTimeout(() => setStatus(''), 3000);
    } else {
      setStatus('');
    }
  });

  document.getElementById('export-xml-btn').addEventListener('click', () => {
    if (!lastQueryText) return;
    const mode = document.getElementById('xml-mode').value;
    window.api.exportXml(lastQueryText, mode);
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

  // ── Saved Queries ─────────────────────────────────────────────────────────
  let savedQueries = [];

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderSavedList() {
    const list = document.getElementById('saved-list');
    if (savedQueries.length === 0) {
      list.innerHTML = '<div class="saved-empty">No saved queries yet.</div>';
      return;
    }
    list.innerHTML = savedQueries.map(q => `
      <div class="saved-item" data-id="${escHtml(q.id)}">
        <div class="saved-item-name">${escHtml(q.name)}</div>
        <div class="saved-item-preview">${escHtml(q.query.slice(0, 80))}&hellip;</div>
        <div class="saved-item-actions">
          <button class="btn-ghost saved-load-btn">Load</button>
          <button class="btn-ghost saved-del-btn">&#x2715;</button>
        </div>
      </div>`).join('');
  }

  // Load saved queries on startup
  window.api.loadQueries().then(list => { savedQueries = list; renderSavedList(); });

  // Toggle panel open/close
  document.getElementById('saved-queries-btn').addEventListener('click', () => {
    document.getElementById('saved-panel').classList.toggle('hidden');
  });
  document.getElementById('saved-panel-close').addEventListener('click', () => {
    document.getElementById('saved-panel').classList.add('hidden');
  });

  // Event delegation for load + delete
  document.getElementById('saved-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.saved-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.classList.contains('saved-load-btn')) {
      const q = savedQueries.find(x => x.id === id);
      if (q && editor) { editor.setValue(q.query); editor.focus(); }
      document.getElementById('saved-panel').classList.add('hidden');
    } else if (e.target.classList.contains('saved-del-btn')) {
      savedQueries = await window.api.deleteQuery(id);
      renderSavedList();
    }
  });

  // Save current query
  document.getElementById('save-query-btn').addEventListener('click', () => {
    document.getElementById('save-query-btn').classList.add('hidden');
    document.getElementById('save-name-form').classList.remove('hidden');
    document.getElementById('save-name-input').value = '';
    document.getElementById('save-name-input').focus();
  });

  async function commitSave() {
    const name = document.getElementById('save-name-input').value.trim();
    if (name && editor) {
      savedQueries = await window.api.saveQuery(name, editor.getValue());
      renderSavedList();
    }
    document.getElementById('save-name-form').classList.add('hidden');
    document.getElementById('save-query-btn').classList.remove('hidden');
  }

  document.getElementById('save-name-ok').addEventListener('click', commitSave);
  document.getElementById('save-name-cancel').addEventListener('click', () => {
    document.getElementById('save-name-form').classList.add('hidden');
    document.getElementById('save-query-btn').classList.remove('hidden');
  });
  document.getElementById('save-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  commitSave();
    if (e.key === 'Escape') document.getElementById('save-name-cancel').click();
  });

  // ── Data Connection Center ────────────────────────────────────────────────

  let dccConnections = [];
  let dccDatasets    = [];
  let dccEditingConnId = null;
  let dccEditingDsId   = null;

  // Load on startup
  Promise.all([
    window.api.dccLoadConnections(),
    window.api.dccLoadDatasets(),
  ]).then(([conns, datasets]) => {
    dccConnections = conns || [];
    dccDatasets    = datasets || [];
    renderDccConnList();
    renderDccDsList();
  });

  // Panel toggle
  document.getElementById('dcc-btn').addEventListener('click', () => {
    document.getElementById('dcc-panel').classList.toggle('hidden');
  });
  document.getElementById('dcc-panel-close').addEventListener('click', () => {
    document.getElementById('dcc-panel').classList.add('hidden');
  });

  // Tab switching
  document.querySelectorAll('.dcc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dcc-tab').forEach(t => t.classList.remove('dcc-tab--active'));
      tab.classList.add('dcc-tab--active');
      const target = tab.dataset.tab;
      document.getElementById('dcc-tab-connections').style.display = target === 'connections' ? '' : 'none';
      document.getElementById('dcc-tab-datasets').style.display    = target === 'datasets'    ? '' : 'none';
      hideDccForms();
    });
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  function renderDccConnList() {
    const list = document.getElementById('dcc-conn-list');
    if (!dccConnections.length) {
      list.innerHTML = '<div class="dcc-empty">No connections yet.</div>';
      return;
    }
    list.innerHTML = dccConnections.map(c => `
      <div class="dcc-item" data-id="${escHtml(c.id)}">
        <div class="dcc-item-info">
          <div class="dcc-item-name">${escHtml(c.name)}</div>
          <div class="dcc-item-meta">${escHtml(c.kind)}${c.host ? ' · ' + escHtml(c.host) : ''}${c.serverHostname ? ' · ' + escHtml(c.serverHostname) : ''}${c.filePath ? ' · ' + escHtml(c.filePath) : ''}</div>
        </div>
        <div class="dcc-item-actions">
          <button class="btn-ghost dcc-conn-edit-btn" style="font-size:11px">Edit</button>
          <button class="btn-ghost dcc-conn-del-btn" style="font-size:11px">&#x2715;</button>
        </div>
      </div>`).join('');
  }

  function renderDccDsList() {
    const list = document.getElementById('dcc-ds-list');
    if (!dccDatasets.length) {
      list.innerHTML = '<div class="dcc-empty">No datasets yet.<small>Define a connection first, then create a dataset that references it.</small></div>';
      return;
    }
    list.innerHTML = dccDatasets.map(d => {
      const conn = dccConnections.find(c => c.id === d.connectionId);
      return `
        <div class="dcc-item" data-id="${escHtml(d.id)}">
          <div class="dcc-item-info">
            <div class="dcc-item-name"><code>dataset:${escHtml(d.name)}</code></div>
            <div class="dcc-item-meta">${conn ? escHtml(conn.name) : '(deleted connection)'} · ${escHtml((d.query || '').slice(0, 50))}</div>
          </div>
          <div class="dcc-item-actions">
            <button class="btn-ghost dcc-ds-test-btn" style="font-size:11px">Test</button>
            <button class="btn-ghost dcc-ds-edit-btn" style="font-size:11px">Edit</button>
            <button class="btn-ghost dcc-ds-del-btn"  style="font-size:11px">&#x2715;</button>
          </div>
        </div>`;
    }).join('');
  }

  // ── Connection form ─────────────────────────────────────────────────────────

  function openConnForm(conn) {
    dccEditingConnId = conn ? conn.id : null;
    document.getElementById('dcc-conn-form-title').textContent = conn ? 'Edit Connection' : 'New Connection';
    document.getElementById('dcc-f-name').value     = conn?.name            || '';
    document.getElementById('dcc-f-kind').value     = conn?.kind            || 'databricks';
    document.getElementById('dcc-f-host').value     = conn?.host            || conn?.serverHostname || '';
    document.getElementById('dcc-f-port').value     = conn?.port            || '';
    document.getElementById('dcc-f-database').value = conn?.database        || '';
    document.getElementById('dcc-f-httpPath').value = conn?.httpPath        || '';
    document.getElementById('dcc-f-username').value = conn?.username        || '';
    document.getElementById('dcc-f-filePath').value = conn?.filePath        || '';
    document.getElementById('dcc-f-tsc').checked    = conn?.trustServerCertificate || false;
    // Leave password/token blank on edit — user must re-enter to change
    document.getElementById('dcc-f-token').value    = '';
    document.getElementById('dcc-f-password').value = '';
    document.getElementById('dcc-conn-test-result').textContent = '';
    document.getElementById('dcc-conn-test-result').className = 'dcc-test-result';
    updateConnFormFields();
    document.getElementById('dcc-conn-form').classList.remove('hidden');
    document.getElementById('dcc-f-name').focus();
  }

  function updateConnFormFields() {
    const kind = document.getElementById('dcc-f-kind').value;
    const isFile = kind === 'csv' || kind === 'excel';
    const isDatabricks = kind === 'databricks';
    const isSqlServer  = kind === 'sqlserver';
    document.getElementById('dcc-db-fields').style.display   = isFile ? 'none' : '';
    document.getElementById('dcc-file-fields').style.display = isFile ? '' : 'none';
    document.getElementById('dcc-http-label').style.display  = isDatabricks ? '' : 'none';
    document.getElementById('dcc-token-label').style.display = isDatabricks ? '' : 'none';
    document.getElementById('dcc-user-label').style.display  = isDatabricks ? 'none' : '';
    document.getElementById('dcc-pass-label').style.display  = isDatabricks ? 'none' : '';
    document.getElementById('dcc-tsc-label').style.display   = isSqlServer  ? '' : 'none';
    // Databricks uses serverHostname label
    document.getElementById('dcc-host-label').firstChild.textContent =
      isDatabricks ? 'Server Hostname' : 'Host';
    // Hide port for Databricks (uses HTTP path instead)
    document.getElementById('dcc-port-label').style.display  = isDatabricks ? 'none' : '';
  }

  function buildConnFromForm() {
    const kind = document.getElementById('dcc-f-kind').value;
    const conn = {
      id:   dccEditingConnId || Date.now().toString(),
      name: document.getElementById('dcc-f-name').value.trim(),
      kind,
    };
    const hostVal = document.getElementById('dcc-f-host').value.trim();
    if (kind === 'databricks') {
      conn.serverHostname = hostVal;
      conn.httpPath       = document.getElementById('dcc-f-httpPath').value.trim();
      const tok = document.getElementById('dcc-f-token').value;
      if (tok) conn.token = tok;
    } else if (kind === 'csv' || kind === 'excel') {
      conn.filePath = document.getElementById('dcc-f-filePath').value.trim();
    } else {
      conn.host     = hostVal;
      const portVal = document.getElementById('dcc-f-port').value;
      if (portVal) conn.port = parseInt(portVal, 10);
      conn.database = document.getElementById('dcc-f-database').value.trim();
      conn.username = document.getElementById('dcc-f-username').value.trim();
      const pw = document.getElementById('dcc-f-password').value;
      if (pw) conn.password = pw;
      if (kind === 'sqlserver') {
        conn.trustServerCertificate = document.getElementById('dcc-f-tsc').checked;
      }
    }
    return conn;
  }

  document.getElementById('dcc-f-kind').addEventListener('change', updateConnFormFields);

  document.getElementById('dcc-browse-file-btn').addEventListener('click', async () => {
    const fp = await window.api.browseDataFile();
    if (fp) document.getElementById('dcc-f-filePath').value = fp;
  });

  document.getElementById('dcc-conn-test-btn').addEventListener('click', async () => {
    const conn = buildConnFromForm();
    const resultEl = document.getElementById('dcc-conn-test-result');
    resultEl.textContent = 'Testing…';
    resultEl.className = 'dcc-test-result';
    const result = await window.api.dccTestConnection(conn);
    resultEl.textContent = result.ok ? 'Connected successfully' : `Error: ${result.error}`;
    resultEl.className = 'dcc-test-result ' + (result.ok ? 'dcc-test-result--ok' : 'dcc-test-result--error');
  });

  document.getElementById('dcc-conn-save-btn').addEventListener('click', async () => {
    const conn = buildConnFromForm();
    if (!conn.name) { alert('Connection name is required.'); return; }
    dccConnections = await window.api.dccSaveConnection(conn);
    renderDccConnList();
    populateDsConnDropdown();
    hideDccForms();
  });

  document.getElementById('dcc-conn-cancel-btn').addEventListener('click', hideDccForms);

  // Connection list event delegation
  document.getElementById('dcc-conn-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.dcc-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.classList.contains('dcc-conn-edit-btn')) {
      openConnForm(dccConnections.find(c => c.id === id));
    } else if (e.target.classList.contains('dcc-conn-del-btn')) {
      const result = await window.api.dccDeleteConnection(id);
      dccConnections = result.connections || [];
      dccDatasets    = result.datasets    || [];
      renderDccConnList();
      renderDccDsList();
      populateDsConnDropdown();
    }
  });

  // ── Dataset form ────────────────────────────────────────────────────────────

  document.getElementById('dcc-add-conn-btn').addEventListener('click', () => {
    hideDccForms();
    openConnForm(null);
  });

  document.getElementById('dcc-add-ds-btn').addEventListener('click', () => {
    hideDccForms();
    openDsForm(null);
  });

  function populateDsConnDropdown() {
    const sel = document.getElementById('dcc-ds-conn');
    sel.innerHTML = dccConnections.map(c =>
      `<option value="${escHtml(c.id)}">${escHtml(c.name)} (${escHtml(c.kind)})</option>`
    ).join('');
  }

  function openDsForm(ds) {
    dccEditingDsId = ds ? ds.id : null;
    populateDsConnDropdown();
    document.getElementById('dcc-ds-form-title').textContent = ds ? 'Edit Dataset' : 'New Dataset';
    document.getElementById('dcc-ds-name').value     = ds?.name        || '';
    document.getElementById('dcc-ds-conn').value     = ds?.connectionId || (dccConnections[0]?.id || '');
    document.getElementById('dcc-ds-query').value    = ds?.query       || '';
    document.getElementById('dcc-ds-valuecol').value = ds?.valueColumn || '';
    document.getElementById('dcc-ds-test-result').textContent = '';
    document.getElementById('dcc-ds-test-result').className = 'dcc-test-result';
    document.getElementById('dcc-ds-form').classList.remove('hidden');
    document.getElementById('dcc-ds-name').focus();
  }

  document.getElementById('dcc-ds-test-btn').addEventListener('click', async () => {
    const resultEl = document.getElementById('dcc-ds-test-result');
    // If editing an existing dataset, test by ID (uses saved connection credentials)
    // If new, we can't test until saved — show message
    if (!dccEditingDsId) {
      resultEl.textContent = 'Save the dataset first, then test it.';
      resultEl.className = 'dcc-test-result';
      return;
    }
    resultEl.textContent = 'Running…';
    resultEl.className = 'dcc-test-result';
    const result = await window.api.dccTestDataset(dccEditingDsId);
    if (result.ok) {
      const preview = result.preview && result.preview.length ? result.preview.join(', ') : '(no rows)';
      resultEl.textContent = `${result.rowCount} value(s): ${preview}…`;
      resultEl.className = 'dcc-test-result dcc-test-result--ok';
    } else {
      resultEl.textContent = `Error: ${result.error}`;
      resultEl.className = 'dcc-test-result dcc-test-result--error';
    }
  });

  document.getElementById('dcc-ds-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('dcc-ds-name').value.trim();
    if (!name) { alert('Dataset name is required.'); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      alert('Dataset name may only contain letters, numbers, underscores, and hyphens.');
      return;
    }
    const ds = {
      id:           dccEditingDsId || Date.now().toString(),
      name,
      connectionId: document.getElementById('dcc-ds-conn').value,
      query:        document.getElementById('dcc-ds-query').value.trim(),
      valueColumn:  document.getElementById('dcc-ds-valuecol').value.trim(),
    };
    dccDatasets = await window.api.dccSaveDataset(ds);
    dccEditingDsId = ds.id;  // so Test button works immediately after save
    renderDccDsList();
    hideDccForms();
  });

  document.getElementById('dcc-ds-cancel-btn').addEventListener('click', hideDccForms);

  // Dataset list event delegation
  document.getElementById('dcc-ds-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.dcc-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.classList.contains('dcc-ds-test-btn')) {
      const testResultEl = item.querySelector('.dcc-item-test-result') ||
        (() => { const el = document.createElement('div'); el.className = 'dcc-item-test-result'; item.querySelector('.dcc-item-info').appendChild(el); return el; })();
      testResultEl.textContent = 'Running…';
      testResultEl.className = 'dcc-item-test-result';
      const result = await window.api.dccTestDataset(id);
      if (result.ok) {
        const preview = result.preview && result.preview.length ? result.preview.join(', ') : '(no rows)';
        testResultEl.textContent = `${result.rowCount} value(s): ${preview}`;
        testResultEl.className = 'dcc-item-test-result dcc-item-test-result--ok';
      } else {
        testResultEl.textContent = `Error: ${result.error}`;
        testResultEl.className = 'dcc-item-test-result dcc-item-test-result--error';
      }
    } else if (e.target.classList.contains('dcc-ds-edit-btn')) {
      openDsForm(dccDatasets.find(d => d.id === id));
    } else if (e.target.classList.contains('dcc-ds-del-btn')) {
      dccDatasets = await window.api.dccDeleteDataset(id);
      renderDccDsList();
    }
  });

  function hideDccForms() {
    document.getElementById('dcc-conn-form').classList.add('hidden');
    document.getElementById('dcc-ds-form').classList.add('hidden');
    dccEditingConnId = null;
    dccEditingDsId   = null;
  }

  // ── Auto-update banner ────────────────────────────────────────────────────
  if (window.api.onUpdateDownloaded) {
    window.api.onUpdateDownloaded((version) => {
      const bar = document.getElementById('update-bar');
      document.getElementById('update-msg').textContent =
        `\u2191 Version ${version} ready to install`;
      bar.classList.remove('hidden');
    });
    document.getElementById('update-install-btn').addEventListener('click', () => {
      window.api.installUpdate();
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setStatus(text, isError = false, isSuccess = false) {
    const el = document.getElementById('file-status');
    el.textContent = text;
    el.style.color = isError ? 'var(--error)' : isSuccess ? 'var(--success)' : 'var(--text-dim)';
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
