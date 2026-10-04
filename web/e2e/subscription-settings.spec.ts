import { expect, test } from "@playwright/test";

import { defaultSettings, mockApi, type ApiState } from "./fixtures/api";

test("saves one subscription form and applies after confirmation", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, panelRestartHold: true };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=subscription");
    const service = page.getByRole("form", { name: "Subscription", exact: true });
    const save = service.getByRole("button", { name: "Save", exact: true });
    const restart = service.getByRole("button", { name: "Restart & Apply" });
    await expect(save).toBeDisabled();
    await expect(restart).toBeDisabled();
    await service.getByRole("button", { name: "Advanced", exact: true }).click();
    await service.getByLabel("Port", { exact: true }).fill("9443");
    await service.getByLabel("Refresh interval (hours)").fill("24");
    await service.getByLabel("Path", { exact: true }).fill("nested/sub");
    await service
        .getByLabel("Public URL", { exact: true })
        .fill("https://subscriptions.example/proxy/");
    await service.getByLabel("Trusted proxies").fill("127.0.0.1, 10.0.0.0/8");
    await save.click();
    await expect(restart).toBeEnabled();
    expect(state.settings?.subUpdates).toBe("24");
    expect(state.subscriptionSettings?.running.port).toBe(8443);
    expect(state.subscriptionSettings?.saved).toMatchObject({
        port: 9443,
        basePath: "/nested/sub/",
        publicUrl: "https://subscriptions.example/proxy",
        trustedProxies: ["127.0.0.1", "10.0.0.0/8"],
    });
    expect(state.subscriptionSettings?.runningUri).toBe("https://sub.example.com/sub/");
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
    await expect(restart).toBeDisabled();
    expect(state.panelRestarts).toBe(1);
    expect(state.subscriptionSettings?.running).toEqual(state.subscriptionSettings?.saved);
    await page.goto("/clients");
    await page.getByLabel("Connection links for alice").click();
    await expect(
        page.getByRole("dialog").getByText("https://subscriptions.example/proxy/nested/sub/alice", {
            exact: true,
        }),
    ).toBeVisible();
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
    const service = page.getByRole("form", { name: "Subscription", exact: true });
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
    const service = page.getByRole("form", { name: "Subscription", exact: true });
    await service.getByRole("button", { name: "Advanced", exact: true }).click();
    await service.getByLabel("Refresh interval (hours)").fill("24");
    const port = service.getByLabel("Port", { exact: true });
    await port.fill("");
    await expect(service.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await port.fill("9443");
    state.subscriptionSettings!.saved.port = 10443;
    state.panelSettings!.revision = "another-operator";
    await service.getByRole("button", { name: "Save", exact: true }).click();
    await expect(service).toContainText("Configuration changed since you started editing");
    await expect(port).toHaveValue("9443");
    expect(state.settings?.subUpdates).toBe("12");
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
    const service = page.getByRole("form", { name: "Subscription", exact: true });
    await service.getByRole("button", { name: "Advanced", exact: true }).click();
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

test("shows one compact form with full-width Public URL and collapsed advanced fields", async ({
    page,
}, testInfo) => {
    await mockApi(page, { signedIn: true, maintenance: false });
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    await expect(form).toBeVisible();
    await expect(page.getByRole("form", { name: "Subscription service", exact: true })).toHaveCount(
        0,
    );
    await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(1);
    await expect(form.getByRole("button", { name: "Restore defaults" })).toHaveCount(1);
    await expect(form.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false",
    );
    await expect(form.getByLabel("Port", { exact: true })).toBeHidden();
    await expect(form.getByLabel("SSL certificate path")).toBeHidden();
    await expect(form.getByLabel("Public URL")).toBeVisible();
    await expect(form.getByLabel("Path", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width,
    );
    const publicUrl = (await form.getByLabel("Public URL").boundingBox())!;
    const path = (await form.getByLabel("Path", { exact: true }).boundingBox())!;
    const interval = (await form.getByLabel("Refresh interval (hours)").boundingBox())!;
    if (page.viewportSize()!.width >= 600) {
        expect(publicUrl.width).toBeGreaterThan(path.width * 1.9);
        expect(Math.abs(path.y - interval.y)).toBeLessThan(2);
    } else {
        expect(interval.y).toBeGreaterThan(path.y);
    }
    await form.screenshot({ path: testInfo.outputPath("subscription-compact.png") });
    await form.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(form.getByLabel("Port", { exact: true })).toHaveValue("8443");
    await expect(form.getByLabel("SSL certificate path")).toBeVisible();
    await form.screenshot({ path: testInfo.outputPath("subscription-advanced.png") });
    await form.getByRole("button", { name: "Help", exact: true }).click();
    await expect(form.getByText(/Public URL is the external HTTP/)).toBeVisible();
});

test("saves common options immediately without writing unchanged listener settings", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    await form.getByLabel("Refresh interval (hours)").fill("24");
    await form.getByRole("switch", { name: "Show the remaining quota and expiry" }).press("Space");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toContainText("Settings saved.");
    expect(state.settings).toMatchObject({ subUpdates: "24", subShowInfo: "true" });
    expect(state.subscriptionSaves).toBeUndefined();
    await expect(form.getByRole("button", { name: "Restart & Apply" })).toBeDisabled();
    await page.reload();
    await expect(form.getByLabel("Refresh interval (hours)")).toHaveValue("24");
});

test("preserves unsaved changes after partial failure and retries only the remaining write", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    let refuseSave = true;
    await page.route("**/api/settings", async (route) => {
        if (route.request().method() === "POST" && refuseSave) {
            await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                    success: false,
                    msg: "Please retry saving settings.",
                    obj: null,
                }),
            });
        } else {
            await route.fallback();
        }
    });
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    const save = form.getByRole("button", { name: "Save", exact: true });
    await form.getByRole("button", { name: "Advanced", exact: true }).click();
    await form.getByLabel("Port", { exact: true }).fill("9443");
    await form.getByLabel("Refresh interval (hours)").fill("24");
    await save.click();
    await expect(form).toContainText("Some settings were saved.");
    await expect(form.getByLabel("Refresh interval (hours)")).toHaveValue("24");
    expect(state.settings?.subUpdates).toBe("12");
    expect(state.subscriptionSettings?.saved.port).toBe(9443);
    expect(state.subscriptionSaves).toBe(1);
    await expect(form.getByRole("button", { name: "Restart & Apply" })).toBeDisabled();
    refuseSave = false;
    await save.click();
    await expect(save).toBeDisabled();
    await expect(form).not.toContainText("Some settings were saved.");
    expect(state.settings?.subUpdates).toBe("24");
    expect(state.subscriptionSaves).toBe(1);
    await expect(form.getByRole("button", { name: "Restart & Apply" })).toBeEnabled();
});

test("retains common options when their save fails before any listener change", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    let refuseSave = true;
    await page.route("**/api/settings", async (route) => {
        if (route.request().method() === "POST" && refuseSave) {
            await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                    success: false,
                    msg: "Saving is temporarily unavailable.",
                    obj: null,
                }),
            });
        } else {
            await route.fallback();
        }
    });
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    const save = form.getByRole("button", { name: "Save", exact: true });
    await form.getByLabel("Refresh interval (hours)").fill("24");
    await save.click();
    await expect(form).toContainText("Saving is temporarily unavailable.");
    await expect(form).not.toContainText("Some settings were saved.");
    await expect(form.getByLabel("Refresh interval (hours)")).toHaveValue("24");
    expect(state.subscriptionSaves).toBeUndefined();
    refuseSave = false;
    await save.click();
    await expect(form).toContainText("Settings saved.");
    expect(state.settings?.subUpdates).toBe("24");
});

test("stages all defaults, preserves environment overrides and leaves other tabs untouched", async ({
    page,
}) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        settings: {
            ...defaultSettings,
            subUpdates: "24",
            subEncode: "false",
            tgBotToken: "keep-this-token",
        },
    };
    await mockApi(page, state);
    Object.assign(state.subscriptionSettings!.saved, {
        port: 7443,
        publicUrl: "https://custom.example/proxy",
        certFile: "/etc/custom/cert.pem",
        keyFile: "/etc/custom/key.pem",
        trustedProxies: ["10.0.0.0/8"],
    });
    state.subscriptionSettings!.overrides.port = "X_UI_SUBSCRIPTION_PORT";
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    await form.getByRole("button", { name: "Restore defaults" }).click();
    await expect(form).toContainText("Defaults restored in the form.");
    await expect(form.getByLabel("Refresh interval (hours)")).toHaveValue("12");
    await expect(form.getByLabel("Public URL")).toHaveValue("");
    expect(state.settings?.subUpdates).toBe("24");
    expect(state.subscriptionSettings?.saved.publicUrl).toBe("https://custom.example/proxy");
    expect(state.subscriptionSaves).toBeUndefined();
    await form.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(form.getByLabel("Port", { exact: true })).toHaveValue("7443");
    await expect(form.getByLabel("Port", { exact: true })).toBeDisabled();
    await expect(form.getByLabel("SSL certificate path")).toHaveValue("");
    await expect(form.getByLabel("Trusted proxies")).toHaveValue("");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(state.settings).toMatchObject({
        subUpdates: "12",
        subEncode: "true",
        tgBotToken: "keep-this-token",
    });
    expect(state.subscriptionSettings?.saved).toMatchObject({
        port: 7443,
        publicUrl: "",
        certFile: "",
        keyFile: "",
        trustedProxies: [],
    });
});

test("opens invalid advanced fields and keeps them visible while correcting SSL paths", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    state.subscriptionSettings!.saved.certFile = "/etc/cert.pem";
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    await expect(form.getByLabel("SSL certificate path")).toBeVisible();
    await expect(form).toContainText("Set both SSL certificate and key paths");
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await form.getByLabel("SSL key path").fill("/etc/key.pem");
    await expect(form.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute(
        "aria-expanded",
        "true",
    );
    await expect(form.getByLabel("SSL key path")).toHaveValue("/etc/key.pem");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(state.subscriptionSettings?.saved.keyFile).toBe("/etc/key.pem");
});

test("validates cleared refresh intervals and discards the entire draft", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    await form.getByLabel("Refresh interval (hours)").fill("");
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(form).toContainText("Use at least one hour.");
    await form.getByLabel("Public URL").fill("https://draft.example/proxy");
    await form.getByRole("button", { name: "Advanced", exact: true }).click();
    await form.getByLabel("Port", { exact: true }).fill("9443");
    await form.getByRole("button", { name: "Discard changes" }).click();
    await expect(form.getByLabel("Refresh interval (hours)")).toHaveValue("12");
    await expect(form.getByLabel("Public URL")).toHaveValue(
        state.subscriptionSettings!.saved.publicUrl,
    );
    await expect(form.getByLabel("Port", { exact: true })).toHaveValue("8443");
    expect(state.subscriptionSaves).toBeUndefined();
    expect(state.settings?.subUpdates).toBe("12");
});

test("preserves both SSL paths when restoring defaults with one environment-controlled path", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    Object.assign(state.subscriptionSettings!.saved, {
        certFile: "/etc/env/cert.pem",
        keyFile: "/etc/local/key.pem",
    });
    state.subscriptionSettings!.overrides.certFile = "X_UI_SUBSCRIPTION_CERT_FILE";
    await page.goto("/general/settings?tab=subscription");
    const form = page.getByRole("form", { name: "Subscription", exact: true });
    await form.getByRole("button", { name: "Restore defaults" }).click();
    await form.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(form.getByLabel("SSL certificate path")).toHaveValue("/etc/env/cert.pem");
    await expect(form.getByLabel("SSL certificate path")).toBeDisabled();
    await expect(form.getByLabel("SSL key path")).toHaveValue("/etc/local/key.pem");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(state.subscriptionSettings?.saved).toMatchObject({
        certFile: "/etc/env/cert.pem",
        keyFile: "/etc/local/key.pem",
    });
});
