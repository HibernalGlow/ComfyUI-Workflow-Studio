import { defineConfig, type Plugin } from "vite";
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
/**
 * `@material/web/labs/gb` (Material 3 Expressive) writes `import styles from "./fab.css"`, which
 * only resolves on a bundler that gives CSS files a default export. rolldown-vite does not
 * (`MISSING_EXPORT: "default" is not exported by .../ripple.css`), while the package ships the
 * compiled form right next to each sheet as `<name>.cssresult.js` - a CSSStyleSheet default export,
 * which is what these elements assign to `static styles`. Redirect the raw specifier at the
 * compiled one, scoped to importers inside labs/gb so this project's own `import "./theme.css"`
 * still goes through Vite's CSS pipeline.
 */
const gbCssAsSheet: Plugin = {
  name: "material-web-gb-css-as-sheet",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer?.includes("@material/web/labs/gb")) return null;
    if (!/^\.{1,2}\/.*\.css$/.test(source)) return null;
    return this.resolve(source.replace(/\.css$/, ".cssresult.js"), importer, { skipSelf: true });
  },
};

export default defineConfig({
  root: `${root}frontend`,
  base: "/wfm_static/",
  plugins: [gbCssAsSheet, react(), babel({ presets: [reactCompilerPreset()] })],
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
