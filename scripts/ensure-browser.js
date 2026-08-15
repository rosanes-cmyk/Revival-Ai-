// Make sure the automation browser (Chromium) is downloaded INTO node_modules
// BEFORE electron-builder packages the app. The packaged app runs with
// PLAYWRIGHT_BROWSERS_PATH=0 (see electron/main.cjs), which means Playwright
// looks for Chromium inside node_modules/playwright-core/.local-browsers. If
// it isn't there at build time, it never gets bundled — and the installed app
// on another PC fails with "Executable doesn't exist … chrome.exe / Please run
// npx playwright install".
//
// Running this in `predist` guarantees the browser is present and packed, so a
// fresh install on any computer works with no extra steps.
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

process.env.PLAYWRIGHT_BROWSERS_PATH = "0"; // download into node_modules, so it bundles

try {
  // Use the locally-installed Playwright CLI so we don't fetch a different
  // version, and install ONLY Chromium (the engine this app uses).
  const cli = path.join(root, "node_modules", "playwright", "cli.js");
  console.log("> node node_modules/playwright/cli.js install chromium");
  execSync(`node "${cli}" install chromium`, { stdio: "inherit", cwd: root, env: process.env });
  console.log("Chromium is present in node_modules — it will be bundled into the app.");
} catch (err) {
  console.error("\nCould not download Chromium for bundling:", err.message);
  console.error("Check your internet connection and run `npm run dist` again.");
  process.exit(1);
}
