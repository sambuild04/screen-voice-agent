import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

import { handleInvoke } from "./handlers/index.js";
import { setWindowRef } from "./window-ref.js";

let mainWindow: BrowserWindow | null = null;

// Resolve Samuel's app icon for both packaged (resources/icon.png) and
// dev (../build/icon.png relative to compiled dist-electron/main.js) layouts.
// Prefers the higher-resolution PNG so the dock can pick the best size.
function resolveAppIconPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? "", "icon.png"),
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(__dirname, "..", "..", "build", "icon.png"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function requestAccessibilityPermission() {
  execFile(
    "/usr/bin/osascript",
    [
      "-e",
      'tell application "System Events" to name of first application process whose frontmost is true',
    ],
    (error, _stdout, _stderr) => {
      if (error) {
        console.error(
          "[accessibility] permission may not be granted — check System Settings → Privacy → Accessibility",
        );
        execFile("/usr/bin/open", [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ]);
      } else {
        console.log("[accessibility] permission granted ✓");
      }
    },
  );
}

function createWindow() {
  const iconPath = resolveAppIconPath();
  const iconImage = iconPath ? nativeImage.createFromPath(iconPath) : null;

  mainWindow = new BrowserWindow({
    width: 520,
    height: 740,
    alwaysOnTop: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    resizable: true,
    backgroundColor: "#00000000",
    icon: iconImage ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Dock icon comes from the .app bundle in production, but in dev we still see
  // the default Electron icon unless we explicitly set it on app.dock.
  if (process.platform === "darwin" && iconImage && app.dock) {
    app.dock.setIcon(iconImage);
  }

  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist-ui", "index.html"));
  }

  // Route window.open() calls (e.g. external links inside show_content panels)
  // to the user's default browser instead of spawning a new Electron window.
  // Without this handler Electron's modern default is { action: "deny" },
  // which silently swallows clicks inside Samuel's show_content overlays.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url).catch((err) => {
        console.error("[shell.openExternal] failed:", err);
      });
    }
    return { action: "deny" };
  });

  if (process.platform === "darwin") {
    requestAccessibilityPermission();
  }

  setWindowRef(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
    setWindowRef(null);
  });
}

ipcMain.handle(
  "invoke",
  async (_event: Electron.IpcMainInvokeEvent, command: string, args: unknown) => {
    return handleInvoke(command, args as Record<string, unknown>);
  },
);

ipcMain.handle("window:setSize", (_event, width: number, height: number) => {
  if (mainWindow) {
    mainWindow.setSize(Math.round(width), Math.round(height));
  }
});

ipcMain.handle("window:hide", () => {
  if (mainWindow) {
    mainWindow.hide();
  }
});

ipcMain.handle("window:show", () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
