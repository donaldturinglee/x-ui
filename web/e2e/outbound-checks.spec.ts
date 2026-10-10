import { expect, test } from "@playwright/test";

import { mockApi } from "./fixtures/api";

test("checks individual outbounds and Test all, with visible failure reasons", async ({ page }) => {
    await mockApi(page, {
        signedIn: true,
        maintenance: false,
        outbounds: [
            { id: 1, type: "direct", tag: "direct" },
            { id: 2, type: "socks", tag: "offline", server: "127.0.0.1", server_port: 1 },
            { id: 3, type: "block", tag: "block" },
        ],
    });
    let release!: () => void;
    const firstProbe = new Promise<void>((resolve) => {
        release = resolve;
    });
    const calls: number[] = [];
    await page.route("**/api/outbounds/*/check", async (route) => {
        const id = Number(/\/outbounds\/(\d+)\/check/.exec(route.request().url())?.[1]);
        calls.push(id);
        expect(route.request().method()).toBe("POST");
        if (calls.length === 1) await firstProbe;
        await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                success: true,
                msg: "",
                obj:
                    id === 1
                        ? { ok: true, delay: 128, error: "" }
                        : { ok: false, delay: 0, error: "Connection check timed out (15 s)." },
            }),
        });
    });
    await page.goto("/outbounds");
    const direct = page.getByRole("button", { name: "Check direct", exact: true });
    await direct.click();
    await expect(direct).toBeDisabled();
    release();
    await expect(page.getByText("128 ms")).toBeVisible();
    await expect(direct).toBeEnabled();
    await page.getByRole("button", { name: "Test all", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "2/2 checked" })).toBeVisible();
    const failure = page.getByRole("button", { name: "Check failed for offline" });
    await expect(failure).toBeVisible();
    await failure.hover();
    await expect(
        page.getByText("Connection check timed out (15 s).", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("N/A", { exact: true })).toBeVisible();
    expect(calls).toEqual([1, 1, 2]);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(direct).toBeVisible();
    await page.screenshot({ path: "test-results/outbound-checks-mobile.png", fullPage: true });
});
