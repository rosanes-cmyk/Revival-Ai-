// Runtime browser check for `npm start` (localhost mode).
//
// When the app is run with `npm start` (not the packaged Electron build), the
// automation Chromium lives in Playwright's DEFAULT cache — NOT bundled in
// node_modules. Copying the project folder to a new PC brings the code but not
// that browser, so the first run there fails with:
//   "Executable doesn't exist ... chrome.exe / Please run npx playwright install"
//
// This script runs in `prestart`: if Chromium is already present it exits
// instantly; if it's missing it downloads it ONCE (~1-2 min) so both the REI
// automation and the PDF export work with no manual steps. It never blocks the
// server from starting — if the download fails, it prints the one manual
// command and lets the server come up anyway (non-browser features still work).
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function main() {
  let exe = "";
  try {
    const { chromium } = await import("playwright");
    exe = chromium.executablePath();
  } catch { /* playwright not resolvable yet; fall through to install */ }

  if (exe && fs.existsSync(exe)) return; // already installed — nothing to do

  console.log("");
  console.log("First run on this computer — downloading the automation browser (Chromium).");
  console.log("This is a one-time ~150MB download and may take 1-2 minutes. Please wait…");
  console.log("");
  try {
    const cli = path.join(root, "node_modules", "playwright", "cli.js");
    execSync(`node "${cli}" install chromium`, { stdio: "inherit", cwd: root });
    console.log("");
    console.log("✅ Chromium is ready. Starting the app…");
  } catch (err) {
    console.error("");
    console.error("⚠ Could not download Chromium automatically:", err.message);
    console.error("Run this ONCE in this folder, then `npm start` again:");
    console.error("    npx playwright install chromium");
    console.error("(The dashboard will still open, but sending/recheck/PDF need the browser.)");
    // Do not block startup.
  }
}

main();
