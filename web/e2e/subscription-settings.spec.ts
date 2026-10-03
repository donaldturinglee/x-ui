import { expect, test } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

test("saves service configuration separately, previews the URI and applies after confirmation", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false, panelRestartHold: true };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=subscription");
    const service = page.getByRole("form", { name: "Subscription service", exact: true });
    const save = service.getByRole("button", { name: "Save", exact: true });
    const restart = service.getByRole("button", { name: "Restart & Apply" });
    await expect(save).toBeDisabled();
    await expect(restart).toBeDisabled();
    await service.getByLabel("Port", { exact: true }).fill("9443");
    await service.getByLabel("Path", { exact: true }).fill("nested/sub");
    await service
        .getByLabel("Public URL", { exact: true })
        .fill("https://subscriptions.example/proxy/");
    await service.getByLabel("Trusted proxies").fill("127.0.0.1, 10.0.0.0/8");
    await expect(service.getByLabel("Subscription URI after applying")).toHaveValue(
        "https://subscriptions.example/proxy/nested/sub/",
    );
    await save.click();
    await expect(restart).toBeEnabled();
    expect(state.settings?.subUpdates).toBe("12");
    expect(state.subscriptionSettings?.running.port).toBe(8443);
    expect(state.subscriptionSettings?.saved.trustedProxies).toEqual(["127.0.0.1", "10.0.0.0/8"]);
    await expect(service.getByLabel("Current subscription URI")).toHaveValue(
        "https://sub.example.com/sub/",
    );
    await restart.click();
    const dialog = page.getByRole("dialog", { name: "Restart and apply settings" });
    await expect(dialog).toContainText("Subscription: Port");
    await expect(dialog).toContainText("https://subscriptions.example/proxy/nested/sub/");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.panelRestarts).toBeUndefined();
    await restart.click();
    await dialog.getByRole("button", { name: "Restart now" }).click();
    await expect(service).toContainText("Restarting services");
    await expect(save).toBeDisabled();
    state.panelRestartHold = false;
    await expect(service).toContainText("Saved settings are now applied");
    await expect(service.getByLabel("Current subscription URI")).toHaveValue(
        "https://subscriptions.example/proxy/nested/sub/",
    );
    await expect(restart).toBeDisabled();
    expect(state.panelRestarts).toBe(1);
});

test("confirms changes from both pages and keeps Subscription in the updated panel URL", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false, panelRestartHold: true };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const panel = page.getByRole("form", { name: "Panel", exact: true });
    await panel.getByLabel("Port", { exact: true }).fill("9000");
    await panel.getByLabel("Web path").fill("/control/");
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "Subscription", exact: true }).click();
    const service = page.getByRole("form", { name: "Subscription service", exact: true });
    await service.getByRole("switch", { name: "Enable subscriptions" }).press("Space");
    await service.getByRole("button", { name: "Save", exact: true }).click();
    await service.getByRole("button", { name: "Restart & Apply" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Panel and Subscription");
    await expect(dialog).toContainText("Panel: Port");
    await expect(dialog).toContainText("Subscription: Enable subscriptions");
    const updated = new URL("/control/general/settings?tab=subscription", page.url());
    updated.port = "9000";
    await expect(dialog).toContainText(updated.href);
    await dialog.getByRole("button", { name: "Restart now" }).click();
    await expect(service.getByRole("link", { name: /Open updated panel/ })).toHaveAttribute(
        "href",
        updated.href,
    );
    expect(state.panelSettings?.restartJob?.scopes).toEqual(["panel", "subscription"]);
});

test("retains a stale draft until discarded and validates cleared ports", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=subscription");
    const service = page.getByRole("form", { name: "Subscription service", exact: true });
    const port = service.getByLabel("Port", { exact: true });
    await port.fill("");
    await expect(service.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await port.fill("9443");
    state.subscriptionSettings!.saved.port = 10443;
    state.panelSettings!.revision = "another-operator";
    await service.getByRole("button", { name: "Save", exact: true }).click();
    await expect(service).toContainText("Configuration changed since you started editing");
    await expect(port).toHaveValue("9443");
    await service.getByRole("button", { name: "Discard changes" }).click();
    await expect(port).toHaveValue("10443");
});

test("locks environment-controlled fields and reports a subscription rollback", async ({
    page,
}) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        panelRestartOutcome: "rolled_back",
    };
    await mockApi(page, state);
    state.subscriptionSettings!.overrides.port = "X_UI_SUBSCRIPTION_PORT";
    await page.goto("/general/settings?tab=subscription");
    const service = page.getByRole("form", { name: "Subscription service", exact: true });
    await expect(service.getByLabel("Port", { exact: true })).toBeDisabled();
    await expect(service).toContainText("X_UI_SUBSCRIPTION_PORT");
    await service.getByLabel("Path", { exact: true }).fill("/new/");
    await service.getByRole("button", { name: "Save", exact: true }).click();
    await service.getByRole("button", { name: "Restart & Apply" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Restart now" }).click();
    await expect(service).toContainText("has been restored");
    await expect(service.getByLabel("Path", { exact: true })).toHaveValue("/sub/");
    await expect(service.getByRole("button", { name: "Restart & Apply" })).toBeDisabled();
});
