const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");

// Jede Ausgabe bekommt eine eigene Kennung. Die App fragt /version.json ab und lädt neu, sobald eine neuere Version online ist.
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function versionFile() {
  return {
    name: "version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) });
    }
  };
}

module.exports = defineConfig({
  plugins: [react(), versionFile()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID)
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080"
    }
  }
});
