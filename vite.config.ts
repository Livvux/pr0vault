import {defineConfig} from "vite";
import preact from "@preact/preset-vite";
import {resolve} from "node:path";
import {copyFileSync, existsSync, mkdirSync} from "node:fs";

function copyAssets() {
  return {
    name: "copy-assets",
    closeBundle() {
      const root = resolve(__dirname);

      // Copy manifest.json
      if (existsSync(resolve(root, "manifest.json"))) {
        copyFileSync(resolve(root, "manifest.json"), resolve(root, "dist/manifest.json"));
      }

      // Copy icons directory
      const iconsDir = resolve(root, "dist/icons");
      mkdirSync(iconsDir, { recursive: true });
      for (const size of [16, 48, 128]) {
        const src = resolve(root, `dist-icons/icon${size}.png`);
        if (existsSync(src)) {
          copyFileSync(src, resolve(iconsDir, `icon${size}.png`));
        }
      }

      // Copy polyfill
      const polyfillSrc = resolve(root, "node_modules/webextension-polyfill/dist/browser-polyfill.js");
      if (existsSync(polyfillSrc)) {
        copyFileSync(polyfillSrc, resolve(root, "dist/browser-polyfill.js"));
      }
    },
  };
}

export default defineConfig({
  plugins: [preact(), copyAssets()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        popup: resolve(__dirname, "src/popup/index.html"),
        options: resolve(__dirname, "src/options/index.html"),
      },
      output: {
        entryFileNames: "src/[name].js",
        chunkFileNames: "src/[name]-[hash].js",
        assetFileNames: "src/[name].[ext]",
      },
    },
  },
});
