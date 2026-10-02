import { expect, test } from "@playwright/test";

import { defaultPanelSettings, mockApi, type ApiState } from "./fixtures/api";

test("uses the runtime Web path for routing and Panel API calls", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state, "/control/");
    await page.route("**/control/general/settings*", async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
            "<head>",
            '<head><base href="/control/"><script id="x-ui-runtime" type="application/json">{"basePath":"/control/"}</script>',
        );
        await route.fulfill({ response, body });
    });
    await page.goto("/control/general/settings?tab=panel");
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await page.getByLabel("Session length (minutes)").fill("60");
    const saved = page.waitForRequest(
        (request) =>
            request.url().endsWith("/control/api/settings/panel") && request.method() === "POST",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await saved;
    await expect.poll(() => state.panelSettings?.saved.maxAgeSeconds).toBe(3600);
    await page.getByRole("link", { name: "Inbounds", exact: true }).click();
    await expect(page).toHaveURL(/\/control\/inbounds$/);
});

test("saves Panel settings with unit conversion and retains them after reload", async ({
    page,
}) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const panel = page.getByRole("tabpanel", { name: "Panel", exact: true });

    await panel.getByLabel("Port", { exact: true }).fill("9000");
    await panel.getByLabel("Session length (minutes)").fill("1.5");
    await panel.getByLabel("Traffic kept for (days)").fill("1.5");
    await panel.getByLabel("Web path").fill("control");
    await panel.getByLabel("Global traffic reset").fill("Off");
    await panel.getByLabel("Trusted proxies").fill("127.0.0.1, 10.0.0.0/8");
    await panel.getByLabel("Log level").selectOption("warning");
    await panel.getByRole("button", { name: "Save", exact: true }).click();

    await expect.poll(() => state.panelSettings?.saved.port).toBe(9000);
    expect(state.panelSettings?.saved.maxAgeSeconds).toBe(90);
    expect(state.panelSettings?.saved.statsRetentionSeconds).toBe(129_600);
    expect(state.panelSettings?.saved.basePath).toBe("/control/");
    expect(state.panelSettings?.saved.resetSpec).toBe("");
    expect(state.panelSettings?.saved.trustedProxies).toEqual(["127.0.0.1", "10.0.0.0/8"]);
    expect(state.panelSettings?.running.port).toBe(8000);
    await expect(panel).toContainText("waiting for a restart");
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    await page.reload();
    await expect(panel.getByLabel("Port", { exact: true })).toHaveValue("9000");
    await expect(panel.getByLabel("Session length (minutes)")).toHaveValue("1.5");
    await expect(panel).toContainText("waiting for a restart");
});

test("keeps a draft through refresh and refuses a stale save", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const port = page
        .getByRole("tabpanel", { name: "Panel", exact: true })
        .getByLabel("Port", { exact: true });
    await port.fill("9000");

    state.panelSettings!.saved.port = 9100;
    state.panelSettings!.revision = "another-operator";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(port).toHaveValue("9000");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Panel", exact: true })).toContainText(
        "Configuration changed",
    );
    expect(state.panelSettings?.saved.port).toBe(9100);
    await expect(port).toHaveValue("9000");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(port).toHaveValue("9100");
});

test("locks environment-controlled fields while allowing other Panel settings", async ({
    page,
}) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        panelSettings: {
            saved: { ...defaultPanelSettings, port: 9000 },
            running: { ...defaultPanelSettings, port: 9000 },
            revision: "panel-0",
            overrides: { port: "X_UI_SERVER_PORT" },
            restartRequired: false,
        },
    };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    await expect(
        page
            .getByRole("tabpanel", { name: "Panel", exact: true })
            .getByLabel("Port", { exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("tabpanel", { name: "Panel", exact: true })).toContainText(
        "X_UI_SERVER_PORT",
    );
    await page.getByLabel("Session length (minutes)").fill("30");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => state.panelSettings?.saved.maxAgeSeconds).toBe(1800);
    expect(state.panelSettings?.saved.port).toBe(9000);
});

test("does not submit invalid Panel settings and can discard edits", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    await page.goto("/general/settings?tab=panel");
    const save = page.getByRole("button", { name: "Save", exact: true });
    await page
        .getByRole("tabpanel", { name: "Panel", exact: true })
        .getByLabel("Port", { exact: true })
        .fill("");
    await expect(save).toBeDisabled();
    await page
        .getByRole("tabpanel", { name: "Panel", exact: true })
        .getByLabel("Port", { exact: true })
        .fill("9000");
    await page
        .getByRole("tabpanel", { name: "Panel", exact: true })
        .getByLabel("SSL key path")
        .fill("/etc/key.pem");
    await expect(save).toBeDisabled();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(
        page
            .getByRole("tabpanel", { name: "Panel", exact: true })
            .getByLabel("Port", { exact: true }),
    ).toHaveValue("8000");
    await expect(
        page.getByRole("tabpanel", { name: "Panel", exact: true }).getByLabel("SSL key path"),
    ).toHaveValue("");
    expect(state.panelSaves).toBeUndefined();
});
