import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('llmBridge', {
  ping: () => ipcRenderer.invoke('llm:ping'),
  chat: (body) => ipcRenderer.invoke('llm:chat', body),
  chatStream: (body, onToken) => {
    const handler = (_e, acc) => {
      try {
        onToken?.(acc);
      } catch {
        /* ignore UI errors */
      }
    };
    ipcRenderer.on('llm:chat-token', handler);
    return ipcRenderer
      .invoke('llm:chat-stream', body)
      .finally(() => {
        ipcRenderer.removeListener('llm:chat-token', handler);
      });
  },
});
