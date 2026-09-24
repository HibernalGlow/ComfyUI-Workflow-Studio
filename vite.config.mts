import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The plugin serves `static/` at `/wfm_static` (py/wfm.py:87) and is never
 * modified, so the build writes straight into it:
 *   frontend/newui.html  ->  static/newui.html        (the entry URL)
 *   frontend/src/**      ->  static/newui/assets/**   (gitignored)
 *
 * `emptyOutDir` stays false because the outDir is the live `static/` folder that
 * also holds the old UI's files — wiping it would break /wfm. The `prebuild`
 * script removes `static/newui` instead.
 *
 * React Compiler runs through Babel (the reference implementation,
 * babel-plugin-react-compiler 1.0.0) rather than the `compiler: true` shortcut,
 * which is an experimental Rust *port* pinned to oxc-transform-react ^0.145.
 */
export default defineConfig({
  root: `${root}frontend`,
  base: "/wfm_static/",
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: {
      // The one allowed door into the framework-free logic layer.
      core: `${root}static/js/core/index.js`,
    },
  },
  build: {
    outDir: `${root}static`,
    emptyOutDir: false,
    assetsDir: "newui",
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: `${root}frontend/newui.html`,
    },
  },
  server: { port: 5173, strictPort: false },
});
