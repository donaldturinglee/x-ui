import { expect, test } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

test("switches the subscription address, copied value and QR graphic together", async ({
    page,
}) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                writeText: async (value: string) =>
                    sessionStorage.setItem("copiedSubscription", value),
            },
        });
    });
    await mockApi(page, { signedIn: true, maintenance: false });
    await page.goto("/clients");
    await page.getByLabel("Connection links for alice").click();
    const dialog = page.getByRole("dialog", { name: "Connection links" });
    const qr = dialog.getByLabel("Subscription link for alice");
    await expect(qr.locator("svg")).toHaveAttribute("width", "200");
    const originalGraphic = await qr.locator("path").getAttribute("d");

    for (const [format, suffix] of [
        ["links", ""],
        ["clash", "?format=clash"],
        ["json", "?format=json"],
    ]) {
        await dialog.getByLabel("Subscription format").selectOption(format);
        const url = `https://sub.example.com/sub/alice${suffix}`;
        await expect(dialog.getByText(url, { exact: true })).toBeVisible();
        await dialog.getByLabel("Copy subscription link", { exact: true }).click();
        await expect
            .poll(() => page.evaluate(() => sessionStorage.getItem("copiedSubscription")))
            .toBe(url);
        if (suffix) {
            await expect.poll(() => qr.locator("path").getAttribute("d")).not.toBe(originalGraphic);
        }
    }

    await dialog.getByRole("button", { name: "Enlarge QR code" }).click();
    const enlarged = page.getByRole("dialog", { name: "Subscription QR code", exact: true });
    await expect(
        enlarged.getByLabel("Large subscription QR code for alice").locator("svg"),
    ).toHaveAttribute("width", "320");
    await expect(
        enlarged.getByText("https://sub.example.com/sub/alice?format=json", { exact: true }),
    ).toBeVisible();
    await enlarged.getByLabel("Copy enlarged subscription link", { exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("copiedSubscription")))
        .toBe("https://sub.example.com/sub/alice?format=json");
    await enlarged.getByLabel("Close", { exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Enlarge QR code" })).toBeFocused();
    await dialog.getByLabel("Copy link", { exact: true }).click();
    await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("copiedSubscription")))
        .toBe("vless://uuid@edge.example.com:443#alice");
});

test("explains omitted protocols and a format with no usable nodes", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        clientSubscriptionInfo: {
            enabled: true,
            formats: {
                links: { nodeCount: 1, omittedProtocols: ["snell"] },
                clash: { nodeCount: 0, omittedProtocols: ["naive", "snell"] },
                json: { nodeCount: 2, omittedProtocols: [] },
            },
        },
    };
    await mockApi(page, state);
    await page.goto("/clients");
    await page.getByLabel("Connection links for alice").click();
    const dialog = page.getByRole("dialog", { name: "Connection links" });
    await dialog.getByLabel("Subscription format").selectOption("clash");
    await expect(dialog).toContainText("No nodes for Clash / Mihomo");
    await expect(dialog).toContainText("naive, snell");
    await expect(dialog.getByLabel("Subscription link for alice")).toHaveCount(0);
    await expect(dialog.getByLabel("Copy subscription link", { exact: true })).toHaveCount(0);
    await dialog.getByLabel("Subscription format").selectOption("json");
    await expect(dialog).toContainText("2 nodes available");
    await expect(dialog.getByLabel("Subscription link for alice")).toBeVisible();
});

test("reports a disabled subscriber and a stopped subscription service", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    state.clients![0].enable = false;
    state.subscriptionSettings!.running.enabled = false;
    await page.goto("/clients");
    await page.getByLabel("Connection links for alice").click();
    const dialog = page.getByRole("dialog", { name: "Connection links" });
    await expect(dialog).toContainText("Subscriptions are switched off");
    await expect(dialog).toContainText("This subscriber is disabled");
});

for (const failure of ["subscriptionInfoFailure", "subscriptionUriFailure"] as const) {
    test(`reports ${failure} without presenting an importable QR code`, async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false, [failure]: true });
        await page.goto("/clients");
        await page.getByLabel("Connection links for alice").click();
        const dialog = page.getByRole("dialog", { name: "Connection links" });
        await expect(dialog).toContainText(
            failure === "subscriptionInfoFailure"
                ? "Unable to read subscription availability"
                : "Unable to read the subscription address",
        );
        await expect(dialog.getByLabel("Subscription link for alice")).toHaveCount(0);
    });
}

test("fits a long Clash subscription and enlarged QR code on a phone", async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    state.subscriptionSettings!.runningUri = `https://sub.example.com/${"proxy/".repeat(10)}sub/`;
    await page.goto("/clients");
    await page.getByLabel("Connection links for alice").click();
    const dialog = page.getByRole("dialog", { name: "Connection links" });
    await dialog.getByLabel("Subscription format").selectOption("clash");
    await expect(
        dialog.getByText(`${state.subscriptionSettings!.runningUri}alice?format=clash`, {
            exact: true,
        }),
    ).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
    );
    await page.screenshot({
        path: testInfo.outputPath("subscription-mobile.png"),
        animations: "disabled",
    });
    await dialog.getByRole("button", { name: "Enlarge QR code" }).click();
    const enlarged = page.getByRole("dialog", { name: "Subscription QR code", exact: true });
    await expect(enlarged.getByLabel("Large subscription QR code for alice")).toBeVisible();
    expect(await enlarged.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
    );
    await expect(enlarged).toHaveCSS("opacity", "1");
    await page.screenshot({
        path: testInfo.outputPath("subscription-enlarged-mobile.png"),
        animations: "disabled",
    });
});
