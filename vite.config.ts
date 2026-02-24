import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  appType: "spa",
  plugins: [react()],
  server: {
    allowedHosts: ["tokenscomedyclub.linkai.me", ".linkai.me"],
  },
  preview: {
    allowedHosts: ["tokenscomedyclub.linkai.me", ".linkai.me"],
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
