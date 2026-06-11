import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  browseFile:       ()                       => ipcRenderer.invoke('browse-file'),
  loadFile:         (p: string)              => ipcRenderer.invoke('load-file', p),
  runQuery:         (q: string, lim: number | null) => ipcRenderer.invoke('run-query', q, lim),
  copyToClipboard:  (t: string)              => ipcRenderer.invoke('copy-to-clipboard', t),
  exportCsv:        (t: string)              => ipcRenderer.invoke('export-csv', t),
  exportXml:        (q: string, mode: 'keep' | 'exclude') => ipcRenderer.invoke('export-xml', q, mode),
  onWorkerMessage:  (cb: (msg: any) => void) => {
    ipcRenderer.on('worker-message', (_e, msg) => cb(msg));
  },
  onUpdateDownloaded: (cb: (version: string) => void) => {
    ipcRenderer.on('update-downloaded', (_e, version) => cb(version));
  },
  installUpdate:  () => ipcRenderer.send('install-update'),
  loadQueries:    ()                          => ipcRenderer.invoke('load-queries'),
  saveQuery:      (name: string, q: string)   => ipcRenderer.invoke('save-query', name, q),
  deleteQuery:    (id: string)                => ipcRenderer.invoke('delete-query', id),
  // Data Connection Center
  browseDataFile:      ()             => ipcRenderer.invoke('browse-data-file'),
  dccLoadConnections:  ()             => ipcRenderer.invoke('dcc-load-connections'),
  dccSaveConnection:   (conn: any)    => ipcRenderer.invoke('dcc-save-connection', conn),
  dccDeleteConnection: (id: string)   => ipcRenderer.invoke('dcc-delete-connection', id),
  dccTestConnection:   (conn: any)    => ipcRenderer.invoke('dcc-test-connection', conn),
  dccLoadDatasets:     ()             => ipcRenderer.invoke('dcc-load-datasets'),
  dccSaveDataset:      (ds: any)      => ipcRenderer.invoke('dcc-save-dataset', ds),
  dccDeleteDataset:    (id: string)   => ipcRenderer.invoke('dcc-delete-dataset', id),
  dccTestDataset:      (id: string)   => ipcRenderer.invoke('dcc-test-dataset', id),
});
