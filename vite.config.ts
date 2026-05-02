import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5173 },
  // Relative base so the built assets work under Electron's file:// protocol.
  // Vercel deploys this app at /, so ./assets/... resolves identically there.
  base: "./",
});
