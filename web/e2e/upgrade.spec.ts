import { expect, test } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

test("checks, confirms once, restores progress after reload and reloads the new panel", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false, upgradeHold: true };
    await mockApi(page, state);
    await page.goto("/overview");
    await page.getByRole("button", { name: "Upgrade", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Upgrade", exact: true });
    await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Check for updates" }).click();
    await expect(dialog).toContainText("v0.0.2");
    await dialog.screenshot({ path: "test-results/upgrade-dialog.png" });
    expect(state.upgradeStarts).toBeUndefined();
    await dialog.getByRole("button", { name: "Upgrade", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Upgrade to v0.0.2", exact: true });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.upgradeStarts).toBeUndefined();
    await dialog.getByRole("button", { name: "Upgrade", exact: true }).click();
    await confirmation.getByRole("button", { name: "Upgrade now", exact: true }).click();
    await expect(dialog).toContainText("Backing up the installation");
    expect(state.upgradeStarts).toBe(1);
    await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("button", { name: "View upgrade" })).toBeVisible();
    let reloads = 0;
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) reloads++;
    });
    state.upgradeHold = false;
    await expect.poll(() => state.upgrade?.currentVersion).toBe("v0.0.2");
    await expect.poll(() => reloads).toBe(1);
    await page.getByRole("button", { name: "Upgrade", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Upgrade", exact: true })).toContainText(
        "Upgraded to v0.0.2",
    );
    expect(state.upgradeStarts).toBe(1);
});

test("a disconnect is unconfirmed and recovery is shown after reconnection", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        upgradeHold: true,
        upgradeOutcome: "rolled_back",
    };
    await mockApi(page, state);
    await page.goto("/overview");
    await page.getByRole("button", { name: "Upgrade", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Upgrade", exact: true });
    await dialog.getByRole("button", { name: "Check for updates" }).click();
    await dialog.getByRole("button", { name: "Upgrade", exact: true }).click();
    await page
        .getByRole("alertdialog", { name: "Upgrade to v0.0.2" })
        .getByRole("button", { name: "Upgrade now" })
        .click();
    await expect(dialog).toContainText("Backing up the installation");
    state.upgradeDisconnect = true;
    await expect(dialog).toContainText("The upgrade result has not yet been confirmed");
    await expect(dialog).not.toContainText("Upgrade failed");
    state.upgradeDisconnect = false;
    state.upgradeHold = false;
    await expect(dialog).toContainText("Upgrade rolled back to v0.0.1");
    await expect(dialog).toContainText("previous version and database have been restored");
    expect(state.upgradeStarts).toBe(1);
});

test("a changed revision keeps the confirmation open and a failed check does not mean up to date", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false, upgradeCheckFailure: true };
    await mockApi(page, state);
    await page.goto("/overview");
    await page.getByRole("button", { name: "Upgrade", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Upgrade", exact: true });
    await dialog.getByRole("button", { name: "Check for updates" }).click();
    await expect(dialog).toContainText("release could not be checked");
    await expect(dialog).not.toContainText("up to date");
    await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toBeDisabled();
    state.upgradeCheckFailure = false;
    await dialog.getByRole("button", { name: "Check for updates" }).click();
    await dialog.getByRole("button", { name: "Upgrade", exact: true }).click();
    state.upgrade!.configRevision = "changed";
    const confirmation = page.getByRole("alertdialog", { name: "Upgrade to v0.0.2" });
    await confirmation.getByRole("button", { name: "Upgrade now" }).click();
    await expect(confirmation).toContainText("Version or configuration changed");
    expect(state.upgradeStarts).toBeUndefined();
});

test("unsupported installations explain availability", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        upgrade: {
            supported: false,
            reason: "Automatic upgrade requires a Linux systemd installation.",
            currentVersion: "dev",
            platform: "amd64",
            checkState: "unchecked",
            configRevision: "revision",
            canUpgrade: false,
            blockedReason: "Automatic upgrade requires a Linux systemd installation.",
            components: [],
        },
    };
    await mockApi(page, state);
    await page.goto("/overview");
    await page.getByRole("button", { name: "Upgrade", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Upgrade", exact: true });
    await expect(dialog).toContainText("Linux systemd installation");
    await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toBeDisabled();
});

test("recovery failure retains the task and session expiry remains unconfirmed", async ({
    page,
}) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        upgradeHold: true,
        upgradeOutcome: "failed",
    };
    await mockApi(page, state);
    await page.goto("/overview");
    await page.getByRole("button", { name: "Upgrade", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Upgrade", exact: true });
    await dialog.getByRole("button", { name: "Check for updates" }).click();
    await dialog.getByRole("button", { name: "Upgrade", exact: true }).click();
    await page
        .getByRole("alertdialog", { name: "Upgrade to v0.0.2" })
        .getByRole("button", { name: "Upgrade now" })
        .click();
    await expect(dialog).toContainText("Backing up the installation");
    state.upgradeUnauthorized = true;
    await expect(dialog).toContainText("Your session expired");
    await expect(dialog).not.toContainText("Upgrade failed");
    state.upgradeUnauthorized = false;
    state.upgradeHold = false;
    await page.reload();
    await page.getByRole("button", { name: "Upgrade", exact: true }).click();
    await expect(dialog).toContainText("Upgrade requires recovery");
    await expect(dialog).toContainText("x-ui-cli upgrade-resume");
    await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toBeDisabled();
});
