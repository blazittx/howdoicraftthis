import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { ollamaChat, ollamaChatStream, ollamaPing } from './llmBridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

function buildMenu() {
  // Without Edit roles, Chromium on Windows/Linux does not wire Ctrl+V to paste.
  const template = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' }]
      : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 800,
    minWidth: 640,
    minHeight: 500,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function registerLlmIpc() {
  ipcMain.handle('llm:ping', async () => ollamaPing());
  ipcMain.handle('llm:chat', async (_evt, body) => {
    const model = body?.model || 'llama3.2:3b';
    const messages = body?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      throw new Error('llm:chat requires messages[]');
    }
    return ollamaChat({
      model,
      messages,
      format: body?.format ?? 'json',
    });
  });
  ipcMain.handle('llm:chat-stream', async (evt, body) => {
    const model = body?.model || 'llama3.2:3b';
    const messages = body?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      throw new Error('llm:chat-stream requires messages[]');
    }
    return ollamaChatStream({
      model,
      messages,
      format: body?.format ?? 'json',
      onToken: (acc) => {
        try {
          evt.sender.send('llm:chat-token', acc);
        } catch {
          /* window closed */
        }
      },
    });
  });
}

app.whenReady().then(() => {
  registerLlmIpc();
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
