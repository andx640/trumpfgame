const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");

module.exports = defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true
      }
    }
  }
});
