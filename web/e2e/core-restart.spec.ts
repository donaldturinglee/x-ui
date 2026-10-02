import { expect, test, type Page } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

const card = (page: Page) =>
    page.getByRole("heading", { name: "sing-box", exact: true }).locator("../..");
const confirm = async (page: Page) => {
    await card(page).getByRole("button", { name: "Restart sing-box", exact: true }).click();
    await page
        .getByRole("alertdialog", { name: "Restart sing-box on this server" })
        .getByRole("button", { name: "Restart now" })
        .click();
};

test("reports the actual local core independently of maintenance and confirms before restarting", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: true, coreRestartHold: true };
    await mockApi(page, state);
    await page.goto("/overview");
    const core = card(page);
    await expect(core).toContainText("This server");
    await expect(core.getByText("Running", { exact: true })).toBeVisible();
    await expect(core).toContainText("4242");
    await core.getByRole("button", { name: "Restart sing-box", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "Restart sing-box on this server" });
    await expect(dialog).toContainText("Existing proxy connections will be closed");
    await expect(dialog).toContainText("panel will remain available");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(state.coreRestarts).toBeUndefined();
    await confirm(page);
    await expect(core).toContainText("Checking configuration");
    await expect(
        core.getByRole("button", { name: "Restart sing-box", exact: true }),
    ).toBeDisabled();
    state.coreRestartPhase = "verifying";
    await expect(core).toContainText("Checking the new core process");
    state.coreRestartHold = false;
    await expect(core).toContainText("sing-box restarted successfully");
    await expect(core).toContainText("4243");
    await expect(core.getByRole("button", { name: "Restart sing-box", exact: true })).toBeEnabled();
    expect(state.coreRestarts).toBe(1);
    expect(state.panelRestarts).toBeUndefined();
    expect(state.maintenance).toBe(true);
    await core.screenshot({ path: "test-results/core-card.png" });
});

test("validation failure keeps the process and exposes logs with a retry", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, coreRestartOutcome: "failed" };
    await mockApi(page, state);
    await page.goto("/overview");
    await confirm(page);
    const core = card(page);
    await expect(core).toContainText("Restart failed. View logs for details.", { timeout: 15000 });
    await expect(core).toContainText("4242");
    await expect(core.getByRole("button", { name: "Restart sing-box", exact: true })).toBeEnabled();
    await core.getByRole("button", { name: "Logs", exact: true }).click();
    const logs = page.getByRole("dialog", { name: "sing-box logs" });
    await expect(logs).toContainText(
        "configuration failed validation; the service was not restarted",
    );
    await expect(logs.getByLabel("sing-box log output")).toContainText("Statistics API listening");
    await logs
        .getByRole("button", { name: "Close", exact: true })
        .filter({ hasText: /^Close$/ })
        .click();
    state.coreRestartOutcome = "succeeded";
    await confirm(page);
    await expect(core).toContainText("sing-box restarted successfully", { timeout: 15000 });
    expect(state.coreRestarts).toBe(2);
});

test("reload follows the existing job without scheduling a second restart", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, coreRestartHold: true };
    await mockApi(page, state);
    await page.goto("/overview");
    await confirm(page);
    await expect(card(page)).toContainText("Checking configuration");
    await page.reload();
    await expect(
        card(page).getByRole("button", { name: "Restart sing-box", exact: true }),
    ).toBeDisabled();
    state.coreRestartHold = false;
    await expect(card(page)).toContainText("sing-box restarted successfully");
    expect(state.coreRestarts).toBe(1);
});

test("unsupported local installations show the reason and disable restart", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        coreStatus: {
            supported: false,
            state: "inactive",
            pid: 0,
            uptimeSeconds: 0,
            reason: "A local sing-box systemd service is not installed.",
        },
    };
    await mockApi(page, state);
    await page.goto("/overview");
    await expect(card(page).getByText("Stopped", { exact: true })).toBeVisible();
    await expect(card(page)).toContainText("A local sing-box systemd service is not installed.");
    await expect(
        card(page).getByRole("button", { name: "Restart sing-box", exact: true }),
    ).toBeDisabled();
    expect(state.coreRestarts).toBeUndefined();
});

test("a rejected request stays in the confirmation dialog and allows retry", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.route("**/api/core/restart", (route) =>
        route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
                success: false,
                msg: "The restart task could not be scheduled; sing-box was not restarted.",
            }),
        }),
    );
    await page.goto("/overview");
    await confirm(page);
    const dialog = page.getByRole("alertdialog", { name: "Restart sing-box on this server" });
    await expect(dialog).toContainText("The restart task could not be scheduled");
    await expect(dialog.getByRole("button", { name: "Restart now" })).toBeEnabled();
    expect(state.coreRestarts).toBeUndefined();
});

test("existing tile preferences gain the core card and retain hidden cards", async ({ page }) => {
    await page.addInitScript(() =>
        localStorage.setItem(
            "x-ui.tiles",
            JSON.stringify({ version: 0, state: { tiles: ["i-sys"] } }),
        ),
    );
    await mockApi(page, { signedIn: true, maintenance: false });
    await page.goto("/overview");
    await expect(card(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "System info" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "CPU gauge" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Panel info" })).toHaveCount(0);
    expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem("x-ui.tiles")!)),
    ).toMatchObject({ version: 1, state: { tiles: ["i-sys", "i-core"] } });
});
