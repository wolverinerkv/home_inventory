// Bundles src/ into www/ for Capacitor. No network, no dynamic code.
import { build } from "esbuild";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";

rmSync("www", { recursive: true, force: true });
mkdirSync("www", { recursive: true });
copyFileSync("src/index.html", "www/index.html");
await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["chrome100", "safari15"],
  outfile: "www/app.js",
  legalComments: "external",
  logLevel: "info",
});
