import { defineConfig, devices } from "@playwright/test";

// The suite brings up a server of its own rather than sharing the one `npm run
// dev` starts, so a run neither depends on that port being free nor takes it
// over while someone is working on it.
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
    // The unit suite lives in `tests` and runs under Vitest, so the two are kept
    // apart by directory rather than by naming each file carefully.
    testDir: "./e2e",
    // Every test says what it needs of the API itself and shares nothing with
    // the rest, so there is no reason for them to wait on one another.
    fullyParallel: true,
    // A focused run passes by leaving the other tests out, so CI refuses one
    // rather than reporting the whole suite green off a single case.
    forbidOnly: Boolean(process.env.CI),
    // A test that only fails sometimes is worth seeing again before it is called
    // a failure, but locally the first answer is the useful one.
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: BASE_URL,
        // A trace costs time to record, so only the retry of something that has
        // already failed once carries one.
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: `npm run dev -- --port ${PORT} --strictPort`,
        url: `${BASE_URL}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // The suite answers every API call itself, so nothing here talks to a
        // Go server and the proxy in the dev config is never reached.
        env: {
            VITE_BASE_URL: "/api",
            VITE_APP_TITLE: "x-ui",
        },
    },
});
