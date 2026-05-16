import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// Ensures .wasm files served in dev get Content-Type: application/wasm,
// which is required for WebAssembly.instantiateStreaming().
function wasmMimePlugin(): Plugin {
  return {
    name: "wasm-content-type",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith(".wasm")) {
          res.setHeader("Content-Type", "application/wasm");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), wasmMimePlugin()],
  server: { host: "0.0.0.0", port: 5173 },
  base: "./",
  optimizeDeps: {
    exclude: ["@xenova/transformers"],
  },
});
