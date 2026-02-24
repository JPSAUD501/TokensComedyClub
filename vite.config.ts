import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  appType: "spa",
  plugins: [react()],
  server: {
    allowedHosts: true,
  },
  preview: {
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        broadcast: "broadcast.html",
      },
    },
  },
});
