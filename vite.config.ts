import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  appType: "spa",
  plugins: [react()],
  preview: {
    allowedHosts: ["tokenscomedyclub.linkai.me"],
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
