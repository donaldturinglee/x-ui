import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The Go server supplies the document base at runtime, so a saved Web path
// applies to assets, routing and API calls without rebuilding the panel.
const BASE_PATH = "./";

// Where the Go server listens in development. The dev server proxies to it
// rather than the browser calling it directly: the session is a cookie and the
// API refuses a cross-origin write, so the two have to look like one origin.
const API_TARGET = "http://127.0.0.1:8000";

export default defineConfig({
    base: BASE_PATH,
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    server: {
        port: 3000,
        proxy: {
            // changeOrigin is deliberately left off. The API compares the
            // request's Origin against its own Host to refuse cross-site
            // writes, and rewriting the Host to the target would make every
            // write from the dev server look like one.
            "/api": {
                target: API_TARGET,
            },
        },
    },
    build: {
        // Vite writes to `dist` on its own, so the directory the app packages
        // into is named here rather than left to the default. The Go server
        // serves this directory when it is present.
        outDir: "build",
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./tests/setup.ts"],
        include: ["tests/**/*.test.{ts,tsx}"],
    },
});
