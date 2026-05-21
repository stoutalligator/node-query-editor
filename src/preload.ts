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
});
