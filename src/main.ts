import { app, BrowserWindow, ipcMain, dialog, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { autoUpdater } from 'electron-updater';

let mainWindow: BrowserWindow | null = null;
let worker: Worker | null = null;

// ── Saved queries ─────────────────────────────────────────────────────────────

type SavedQuery = { id: string; name: string; query: string };

const savedQueriesPath = () => path.join(app.getPath('userData'), 'saved-queries.json');

function readSavedQueries(): SavedQuery[] {
  try { return JSON.parse(fs.readFileSync(savedQueriesPath(), 'utf8')); }
  catch { return []; }
}

function writeSavedQueries(list: SavedQuery[]): void {
  fs.writeFileSync(savedQueriesPath(), JSON.stringify(list, null, 2), 'utf8');
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

function createWorker(): Worker {
  const workerPath = path.join(__dirname, 'worker.js');
  const w = new Worker(workerPath);

  w.on('message', (msg) => {
    if (mainWindow) mainWindow.webContents.send('worker-message', msg);
  });

  w.on('error', (err) => {
    console.error('Worker error:', err);
    if (mainWindow) {
      mainWindow.webContents.send('worker-message', {
        type: 'fileError',
        message: `Worker error: ${err.message}`,
      });
    }
  });

  w.on('exit', (code) => {
    if (code !== 0) console.error(`Worker exited with code ${code}`);
    worker = null;
  });

  return w;
}

function getWorker(): Worker {
  if (!worker) worker = createWorker();
  return worker;
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Node Extract',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });

  autoUpdater.checkForUpdates().catch(() => { /* ignore — dev build or offline */ });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-downloaded', info.version);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: auto-update ─────────────────────────────────────────────────────────

ipcMain.on('install-update', () => { autoUpdater.quitAndInstall(); });

// ── IPC: file operations ──────────────────────────────────────────────────────

ipcMain.handle('browse-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select XML or JSON file',
    filters: [
      { name: 'XML / JSON', extensions: ['xml', 'json'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('load-file', async (_event, filePath: string) => {
  try {
    const stat = fs.statSync(filePath);
    const SIZE_WARN  = 50  * 1024 * 1024;  // 50 MB
    const SIZE_BLOCK = 500 * 1024 * 1024;  // 500 MB

    if (stat.size > SIZE_BLOCK) {
      return { error: `File is ${(stat.size / 1024 / 1024).toFixed(0)} MB — too large to load (limit 500 MB).` };
    }

    const warning = stat.size > SIZE_WARN
      ? `Large file (${(stat.size / 1024 / 1024).toFixed(0)} MB) — parsing may take a moment.`
      : null;

    getWorker().postMessage({ type: 'loadFile', filePath });
    return { ok: true, warning };
  } catch (err: any) {
    return { error: err.message };
  }
});

ipcMain.handle('run-query', (_event, queryText: string, limit: number | null) => {
  getWorker().postMessage({ type: 'runQuery', queryText, limit });
});

// ── IPC: clipboard + CSV export ───────────────────────────────────────────────

ipcMain.handle('copy-to-clipboard', (_event, text: string) => {
  clipboard.writeText(text);
});

ipcMain.handle('load-queries', () => readSavedQueries());

ipcMain.handle('save-query', (_event, name: string, query: string) => {
  const list = readSavedQueries();
  list.unshift({ id: Date.now().toString(), name, query });
  writeSavedQueries(list);
  return list;
});

ipcMain.handle('delete-query', (_event, id: string) => {
  const list = readSavedQueries().filter(q => q.id !== id);
  writeSavedQueries(list);
  return list;
});

ipcMain.handle('export-csv', async (_event, csvText: string) => {
  if (!mainWindow) return { saved: false };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export CSV',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    defaultPath: 'query-result.csv',
  });
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, csvText, 'utf8');
    return { saved: true };
  }
  return { saved: false };
});

ipcMain.handle('export-xml', async (_event, queryText: string, mode: 'keep' | 'exclude') => {
  if (!mainWindow) return;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Filtered XML',
    filters: [{ name: 'XML', extensions: ['xml'] }],
    defaultPath: 'filtered-export.xml',
  });
  if (!result.canceled && result.filePath) {
    getWorker().postMessage({ type: 'exportXml', queryText, mode, savePath: result.filePath });
  }
});
