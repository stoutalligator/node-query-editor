import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  browseFile:       ()                       => ipcRenderer.invoke('browse-file'),
  loadFile:         (p: string)              => ipcRenderer.invoke('load-file', p),
  runQuery:         (q: string, lim: number | null) => ipcRenderer.invoke('run-query', q, lim),
  copyToClipboard:  (t: string)              => ipcRenderer.invoke('copy-to-clipboard', t),
  exportCsv:        (t: string)              => ipcRenderer.invoke('export-csv', t),
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
});
