import { expect, test } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

test("Save leaves the configuration pending and restart applies it after confirmation", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false, panelRestartHold: true };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const panel = page.getByRole("tabpanel", { name: "Panel", exact: true });
    const restart = panel.getByRole("button", { name: "Restart & Apply", exact: true });
    await expect(restart).toBeDisabled();
    await panel.getByLabel("Session length (minutes)").fill("30");
    await expect(restart).toBeDisabled();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(restart).toBeEnabled();
    expect(state.panelRestarts).toBeUndefined();
    expect(state.panelSettings?.running.maxAgeSeconds).not.toBe(1800);

    await restart.click();
    const dialog = page.getByRole("dialog", { name: "Restart and apply Panel settings" });
    await expect(dialog).toContainText("briefly unavailable");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.panelRestarts).toBeUndefined();
    await restart.click();
    await dialog.getByRole("button", { name: "Restart now", exact: true }).click();
    await expect(panel).toContainText("Restarting the panel");
    await expect(panel.getByLabel("Session length (minutes)")).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(state.panelRestarts).toBe(1);
    state.panelRestartHold = false;
    await expect(panel).toContainText("Saved settings are now applied");
    await expect(panel.getByLabel("Session length (minutes)")).toBeEnabled();
    await expect(restart).toBeDisabled();
    expect(state.panelSettings?.running.maxAgeSeconds).toBe(1800);
});

test("restores the old values when applying a saved configuration fails", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        panelRestartOutcome: "rolled_back",
    };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const panel = page.getByRole("tabpanel", { name: "Panel", exact: true });
    await panel.getByLabel("Port", { exact: true }).fill("9000");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await panel.getByRole("button", { name: "Restart & Apply", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restart now" }).click();
    await expect(panel).toContainText("The previous Panel configuration has been restored");
    await expect(panel.getByLabel("Port", { exact: true })).toHaveValue("8000");
    await expect(panel.getByLabel("Port", { exact: true })).toBeEnabled();
    expect(state.panelSettings?.restartRequired).toBe(false);
});

test("shows the updated address without treating a disconnect as a failed restart", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false, panelRestartHold: true };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const panel = page.getByRole("tabpanel", { name: "Panel", exact: true });
    await panel.getByLabel("Port", { exact: true }).fill("9000");
    await panel.getByLabel("Web path").fill("/control/");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await panel.getByRole("button", { name: "Restart & Apply", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const updatedAddress = new URL("/control/general/settings?tab=panel", page.url());
    updatedAddress.port = "9000";
    await expect(dialog).toContainText(updatedAddress.href);
    await dialog.getByRole("button", { name: "Restart now" }).click();
    await expect(panel.getByRole("link", { name: /Open updated panel/ })).toHaveAttribute(
        "href",
        updatedAddress.href,
    );
    await page.route("**/api/settings/panel/restart/restart-1", (route) =>
        route.abort("connectionrefused"),
    );
    await expect(panel).toContainText("Restarting the panel");
    await expect(page).toHaveURL(/\/general\/settings\?tab=panel$/);
    await expect(panel).not.toContainText("The services did not recover");
});

test("reload follows an existing restart task", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, panelRestartHold: true };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const panel = page.getByRole("tabpanel", { name: "Panel", exact: true });
    await panel.getByLabel("Log level").selectOption("warning");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await panel.getByRole("button", { name: "Restart & Apply", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restart now" }).click();
    await expect(panel).toContainText("Restarting the panel");
    await page.reload();
    await expect(
        panel.getByRole("button", { name: "Restart & Apply", exact: true }),
    ).toBeDisabled();
    state.panelRestartHold = false;
    await expect(panel).toContainText("Saved settings are now applied");
    expect(state.panelRestarts).toBe(1);
});

test("rejects a configuration changed after the confirmation dialog opened", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const panel = page.getByRole("tabpanel", { name: "Panel", exact: true });
    await panel.getByLabel("Log level").selectOption("warning");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await panel.getByRole("button", { name: "Restart & Apply", exact: true }).click();
    state.panelSettings!.revision = "another-operator";
    await page.getByRole("dialog").getByRole("button", { name: "Restart now" }).click();
    await expect(panel).toContainText("Configuration changed; refresh before applying it");
    expect(state.panelRestarts).toBeUndefined();
});
