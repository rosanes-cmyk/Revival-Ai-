// Electron desktop wrapper for the High Equity Lead Revival Dashboard.
//
// This turns the web dashboard into a real double-click desktop application:
// it starts the existing Express server in the background, waits for it to be
// ready, then shows the dashboard inside its own app window — no terminal, no
// typing "npm start", no "localhost" to remember.
//
// The automation (Playwright driving REI BlackBook / Redfin) is unchanged; it
// still opens its own visible browser window so the one-time REI login / 2FA
// works exactly as before.

const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = `http://localhost:${PORT}`;

let serverProc = null;
let mainWindow = null;

// The app root (where package.json + server/ live). Works in dev and when
// packaged (electron-builder keeps the same relative layout).
const APP_ROOT = app.getAppPath();
const SERVER_ENTRY = path.join(APP_ROOT, "server", "index.js");

// Start the Node server using Electron's own bundled Node runtime, so no
// separate Node.js install is required once the app is packaged.
function startServer() {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1", // run the electron binary as plain Node
    PORT: String(PORT),
  };
  // In a packaged app the automation browser is bundled inside the app's
  // node_modules (PLAYWRIGHT_BROWSERS_PATH=0), so point Playwright there. In
  // dev we leave it unset so it uses the normal per-user browser cache.
  if (app.isPackaged) {
    env.PLAYWRIGHT_BROWSERS_PATH = "0";
    const unpacked = APP_ROOT.replace("app.asar", "app.asar.unpacked");
    serverProc = spawn(process.execPath, [path.join(unpacked, "server", "index.js")], {
      cwd: unpacked,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    serverProc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: APP_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  serverProc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on("exit", (code) => {
    serverProc = null;
    // If the server dies unexpectedly while the app is open, tell the user.
    if (code && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        "Revival Dashboard stopped",
        `The dashboard engine stopped unexpectedly (code ${code}). Please close and reopen the app.`
      );
    }
  });
}

// Poll the server until it answers, then run the callback. Fails after ~30s.
function waitForServer(cb, attempt = 0) {
  const req = http.get(BASE_URL, () => cb(true));
  req.on("error", () => {
    if (attempt > 150) return cb(false); // ~30s at 200ms
    setTimeout(() => waitForServer(cb, attempt + 1), 200);
  });
  req.setTimeout(1500, () => req.destroy());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#0b0b0d",
    title: "Revival AI — High Equity Lead Revival",
    icon: path.join(APP_ROOT, "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Open target=_blank / external links in the real browser, not a blank app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE_URL)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  const loading = `data:text/html,${encodeURIComponent(
    `<body style="margin:0;background:#0b0b0d;color:#eaeaea;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><div style="font-size:22px;margin-bottom:8px">High Equity Lead Revival</div><div style="opacity:.7">Starting the dashboard…</div></div></body>`
  )}`;
  mainWindow.loadURL(loading);

  waitForServer((ok) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (ok) {
      mainWindow.loadURL(BASE_URL);
    } else {
      dialog.showErrorBox(
        "Could not start",
        "The dashboard did not start in time. Please close and reopen the app. If it keeps happening, contact support."
      );
    }
  });

  mainWindow.on("closed", () => (mainWindow = null));
}

// Single-instance: focus the existing window instead of opening a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    startServer();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

function stopServer() {
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* ignore */
    }
    serverProc = null;
  }
}

app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", stopServer);
app.on("quit", stopServer);
