/**
 * ConstructOS desktop (Electron).
 *
 * The bundled web app is served from a private `app://constructos` origin.
 * Requests it makes to /api, /sync and /ai are forwarded by this main process
 * to the ConstructOS server (default https://baheka-construct-os.com), exactly
 * as the load balancer routes them on the web. So the UI is unchanged, and
 * the API needs no CORS changes.
 *
 * Security: no Node in the renderer (contextIsolation + sandbox), a strict CSP,
 * no navigation away from the app, external links open in the system browser,
 * and every permission request (camera, location, …) is denied.
 */
import { app, BrowserWindow, Menu, net, protocol, session, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { forwardHeaders, isServicePath, resolveStatic, validateServer } from './routing';

const SCHEME = 'app';
const HOST = 'constructos';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
const DEFAULT_SERVER = 'https://baheka-construct-os.com';
/** Set to the Vite dev server (http://localhost:5173) while developing the UI. */
const DEV_URL = process.env.CONSTRUCTOS_DEV_URL;

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ----------------------------------------------------------------- settings

interface Settings {
  /** Base URL of the ConstructOS server. HTTPS only, except localhost for development. */
  serverUrl: string;
}

function settingsPath() {
  return join(app.getPath('userData'), 'settings.json');
}

function loadSettings(): Settings {
  const fromEnv = process.env.CONSTRUCTOS_SERVER;
  let serverUrl = fromEnv ?? DEFAULT_SERVER;
  if (!fromEnv && existsSync(settingsPath())) {
    try {
      const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>;
      if (saved.serverUrl) serverUrl = saved.serverUrl;
    } catch {
      /* unreadable settings: fall back to the default */
    }
  }
  return { serverUrl: validateServer(serverUrl) };
}

function ensureSettingsFile(settings: Settings) {
  if (existsSync(settingsPath())) return;
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// ----------------------------------------------------------------- app:// handler

/** The built web app: packaged under resources/web, or ../web/dist in a checkout. */
function webRoot() {
  return app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, '..', '..', 'web', 'dist');
}

/** Strict CSP. Uploads and downloads use presigned S3 URLs, so S3 is allowed for connect/img. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.amazonaws.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.amazonaws.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

function registerAppProtocol(server: string) {
  const root = normalize(webRoot());
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });

    // Backend calls: forward to the server, as the load balancer does on the web.
    if (isServicePath(url.pathname)) {
      const headers = forwardHeaders(request.headers);
      const method = request.method.toUpperCase();
      try {
        return await net.fetch(`${server}${url.pathname}${url.search}`, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer(),
          redirect: 'manual',
        });
      } catch {
        return Response.json({ message: `Cannot reach ConstructOS at ${server}. Check your connection.` }, { status: 503 });
      }
    }

    // Static files, with the index page for client-side routes. Never outside the web root.
    const requested = resolveStatic(root, url.pathname);
    if (!requested) return new Response('Not found', { status: 404 });
    const isFile = existsSync(requested) && statSync(requested).isFile();
    const file = isFile ? requested : join(root, 'index.html');
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

// ----------------------------------------------------------------- window

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'ConstructOS',
    backgroundColor: '#0b0f14',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  const allowedOrigin = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
  // Stay inside the app; anything else (presigned downloads, help links) opens in the system browser.
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== allowedOrigin) {
      event.preventDefault();
      openExternal(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);

  // Development only: save a screenshot after load and quit (used to check rendering in CI / scripts).
  const shot = process.env.CONSTRUCTOS_SCREENSHOT;
  if (shot && !app.isPackaged) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents.capturePage().then((img) => {
          writeFileSync(shot, img.toPNG());
          app.quit();
        });
      }, 2500);
    });
  }
  return win;
}

function openExternal(target: string) {
  try {
    if (new URL(target).protocol === 'https:') void shell.openExternal(target);
  } catch {
    /* ignore malformed URLs */
  }
}

function buildMenu(server: string) {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: `Server: ${new URL(server).host}`, enabled: false },
        { label: 'Open settings file…', click: () => void shell.openPath(settingsPath()) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
      ],
    },
    { label: 'Help', submenu: [{ label: 'ConstructOS on the web', click: () => openExternal(server) }, { label: `Version ${app.getVersion()}`, enabled: false }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    const settings = loadSettings();
    ensureSettingsFile(settings);
    // Deny camera, microphone, location, notifications etc. The app does not use them.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    registerAppProtocol(settings.serverUrl);
    buildMenu(settings.serverUrl);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Defence in depth: no other web contents may be created with Node or extra privileges.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
