import { expect, test, type Page } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

const card = (page: Page) =>
    page.getByRole("heading", { name: "sing-box", exact: true }).locator("../..");
const open = async (page: Page) => {
    await card(page).getByRole("button", { name: "Version management" }).click();
    return page.getByRole("dialog", { name: "sing-box versions", exact: true });
};
const checkAndConfirm = async (page: Page, direction: "Upgrade" | "Downgrade", version: string) => {
    const dialog = await open(page);
    await dialog.getByLabel("Target version").selectOption(version);
    await dialog.getByRole("button", { name: "Check selected version" }).click();
    await dialog.getByRole("button", { name: direction, exact: true }).click();
    await page
        .getByRole("alertdialog", { name: `${direction} sing-box to ${version}` })
        .getByRole("button", { name: `${direction} now`, exact: true })
        .click();
    return dialog;
};

test("downgrade requires a pinned check and confirmation, and resumes after reload", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false, coreVersionHold: true };
    await mockApi(page, state);
    await page.goto("/overview");
    await expect(card(page)).toContainText("1.14.2");
    await expect(card(page).getByRole("button", { name: "Version management" })).toBeEnabled();
    expect(
        await card(page).evaluate((element) => {
            const bottom = element.getBoundingClientRect().bottom;
            return Array.from(element.querySelectorAll("button, p")).every(
                (child) => child.getBoundingClientRect().bottom <= bottom + 1,
            );
        }),
    ).toBe(true);
    await card(page).screenshot({ path: "test-results/core-version-card.png" });
    const dialog = await open(page);
    await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toBeDisabled();
    await dialog.getByLabel("Target version").selectOption("1.14.1");
    await dialog.getByRole("button", { name: "Check selected version" }).click();
    await expect(dialog).toContainText("1.14.2 → 1.14.1");
    await dialog.getByRole("button", { name: "Downgrade", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Downgrade sing-box to 1.14.1" });
    await expect(confirmation).toContainText("Existing proxy connections will be closed");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.coreVersionStarts).toBeUndefined();
    await dialog.getByRole("button", { name: "Downgrade", exact: true }).click();
    await confirmation.getByRole("button", { name: "Downgrade now", exact: true }).click();
    await expect(dialog).toContainText("Downloading and verifying target and recovery packages");
    await expect(
        card(page).getByRole("button", { name: "Restart sing-box", exact: true }),
    ).toBeDisabled();
    await dialog.screenshot({ path: "test-results/core-version-dialog.png" });
    await page.reload();
    await expect(card(page)).toContainText("Downloading and verifying");
    const resumed = await open(page);
    state.coreVersionHold = false;
    await expect(resumed).toContainText("sing-box changed to 1.14.1");
    await expect(card(page)).toContainText("1.14.1");
    expect(state.coreVersionStarts).toBe(1);
    expect(state.upgradeStarts).toBeUndefined();
    expect(state.coreRestarts).toBeUndefined();
});

test("upgrades from an older installed version and updates the core card", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    state.coreVersions!.currentVersion = "1.14.1";
    state.coreStatus!.currentVersion = "1.14.1";
    await page.goto("/overview");
    const dialog = await checkAndConfirm(page, "Upgrade", "1.14.2");
    await expect(dialog).toContainText("sing-box changed to 1.14.2", { timeout: 15000 });
    await expect(card(page)).toContainText("1.14.2");
    expect(state.coreVersionStarts).toBe(1);
});

test("release verification failure cannot start a change", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, coreVersionCheckFailure: true };
    await mockApi(page, state);
    await page.goto("/overview");
    const dialog = await open(page);
    await dialog.getByRole("button", { name: "Check selected version" }).click();
    await expect(dialog).toContainText("selected official release could not be verified");
    await expect(dialog.getByRole("button", { name: "Upgrade", exact: true })).toBeDisabled();
    expect(state.coreVersionStarts).toBeUndefined();
    expect(state.coreStatus!.pid).toBe(4242);
});

test("a changed configuration rejects the confirmed request", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/overview");
    const dialog = await open(page);
    await dialog.getByRole("button", { name: "Check selected version" }).click();
    await dialog.getByRole("button", { name: "Downgrade", exact: true }).click();
    state.coreVersions!.configRevision = "changed";
    const confirmation = page.getByRole("alertdialog", { name: "Downgrade sing-box to 1.14.1" });
    await confirmation.getByRole("button", { name: "Downgrade now" }).click();
    await expect(confirmation).toContainText("Version or configuration changed");
    expect(state.coreVersionStarts).toBeUndefined();
});

test("failed installation reports recovery to the original version", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        coreVersionOutcome: "rolled_back",
    };
    await mockApi(page, state);
    await page.goto("/overview");
    const dialog = await checkAndConfirm(page, "Downgrade", "1.14.1");
    await expect(dialog).toContainText("Restored sing-box 1.14.2", { timeout: 15000 });
    await expect(dialog).toContainText("previous package, configuration and state were restored");
    await expect(card(page)).toContainText("1.14.2");
});

test("unrecovered tasks remain visible and block new changes after reload", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        coreVersionOutcome: "failed",
        coreVersionNeedsRecovery: true,
    };
    await mockApi(page, state);
    await page.goto("/overview");
    const dialog = await checkAndConfirm(page, "Downgrade", "1.14.1");
    await expect(dialog).toContainText("sing-box version change requires recovery", {
        timeout: 15000,
    });
    await page.reload();
    const resumed = await open(page);
    await expect(resumed).toContainText("x-ui-cli core-version-resume");
    await expect(resumed.getByRole("button", { name: "Check selected version" })).toBeDisabled();
    await expect(
        card(page).getByRole("button", { name: "Restart sing-box", exact: true }),
    ).toBeDisabled();
    expect(state.coreVersionStarts).toBe(1);
});

test("unsupported installations explain why version management is disabled", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    state.coreVersions!.supported = false;
    state.coreVersions!.reason =
        "Version management currently supports official APT/DNF sing-box packages";
    await page.goto("/overview");
    const button = card(page).getByRole("button", { name: "Version management" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", /official APT\/DNF/);
});
