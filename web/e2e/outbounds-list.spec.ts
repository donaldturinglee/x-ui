import { expect, test } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

test("sorts outbound names and types locally and restores the original order", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        outbounds: [
            { id: 1, tag: "proxy-10", type: "socks", server: "example.com", server_port: 1080 },
            {
                id: 2,
                tag: "proxy-2",
                type: "vless",
                server: "example.com",
                server_port: 443,
                tls: { enabled: true },
            },
            { id: 3, tag: "direct", type: "direct" },
        ],
    };
    await mockApi(page, state);
    await page.goto("/outbounds");
    const table = page.getByRole("table", { name: "Routes out" });
    const tags = table.locator('tbody [data-column="Tag"]').getByRole("button");
    await expect(tags).toHaveText(["proxy-10", "proxy-2", "direct"]);
    const sortTag = table.getByRole("button", { name: "Sort by Tag", exact: true });
    await sortTag.click();
    await expect(tags).toHaveText(["direct", "proxy-2", "proxy-10"]);
    await expect(table.getByRole("columnheader").first()).toHaveAttribute("aria-sort", "ascending");
    await sortTag.click();
    await expect(tags).toHaveText(["proxy-10", "proxy-2", "direct"]);
    await expect(table.getByRole("columnheader").first()).toHaveAttribute(
        "aria-sort",
        "descending",
    );
    await sortTag.click();
    await expect(table.getByRole("columnheader").first()).not.toHaveAttribute("aria-sort");
    await table.getByRole("button", { name: "Sort by Type", exact: true }).click();
    await expect(tags).toHaveText(["direct", "proxy-10", "proxy-2"]);
    expect(state.outbounds?.map((outbound) => outbound.id)).toEqual([1, 2, 3]);
    await page.screenshot({ path: "test-results/outbounds-list-desktop.png", fullPage: true });
});

test("keeps rows in place during a batch and sorts completed delays numerically", async ({
    page,
}) => {
    await mockApi(page, {
        signedIn: true,
        maintenance: false,
        outbounds: [
            { id: 1, tag: "slow", type: "socks", server: "example.com", server_port: 1080 },
            { id: 2, tag: "fast", type: "socks", server: "example.com", server_port: 1081 },
            { id: 3, tag: "failed", type: "socks", server: "example.com", server_port: 1082 },
            { id: 4, tag: "blocked", type: "block" },
        ],
    });
    let releaseSlow!: () => void;
    const slowProbe = new Promise<void>((resolve) => {
        releaseSlow = resolve;
    });
    const calls: number[] = [];
    await page.route("**/api/outbounds/*/check", async (route) => {
        const id = Number(/\/outbounds\/(\d+)\/check/.exec(route.request().url())?.[1]);
        calls.push(id);
        if (id === 1) await slowProbe;
        await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                success: true,
                msg: "",
                obj: {
                    ok: id !== 3,
                    delay: id === 1 ? 140 : id === 2 ? 8 : 0,
                    error: id === 3 ? "Connection check timed out (15 s)." : "",
                },
            }),
        });
    });
    await page.goto("/outbounds");
    const table = page.getByRole("table", { name: "Routes out" });
    const tags = table.locator('tbody [data-column="Tag"]').getByRole("button");
    const sortDelay = table.getByRole("button", { name: "Sort by Delay", exact: true });
    await sortDelay.click();
    await page.getByRole("button", { name: "Test all", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "2/3 checked" })).toBeVisible();
    await expect(sortDelay).toBeDisabled();
    await expect(tags).toHaveText(["slow", "fast", "failed", "blocked"]);
    await expect(
        table
            .getByRole("row")
            .filter({ has: page.getByRole("cell", { name: "fast", exact: true }) })
            .locator('[data-column="Delay"]'),
    ).toHaveText("8 ms", { useInnerText: true });
    releaseSlow();
    await expect(page.getByRole("status").filter({ hasText: "3/3 checked" })).toBeVisible();
    await expect(tags).toHaveText(["fast", "slow", "failed", "blocked"]);
    await sortDelay.click();
    await expect(tags).toHaveText(["slow", "fast", "failed", "blocked"]);
    expect([...calls].sort()).toEqual([1, 2, 3]);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "Check failed for failed" }).click();
    const failure = page.getByRole("dialog", { name: "Connection check failed", exact: true });
    await expect(failure).toContainText("Connection check timed out (15 s).");
    await failure.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByRole("button", { name: "Check failed for failed" })).toBeFocused();
});

test("provides sorting, full values and row actions on a phone without horizontal overflow", async ({
    page,
}) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const tag = "proxy-with-a-long-tag-".repeat(4);
    const server = "a-very-long-server-name-for-the-outbound.example.com";
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        outbounds: [
            { id: 1, tag, type: "socks", server, server_port: 1080 },
            { id: 2, tag: "direct", type: "direct" },
        ],
    };
    await mockApi(page, state);
    await page.goto("/outbounds");
    const table = page.getByRole("table", { name: "Routes out" });
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table.getByRole("columnheader")).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Edit ${tag}`, exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: `Check ${tag}`, exact: true })).toBeVisible();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByLabel("Sort by", { exact: true }).selectOption("tag:ascending");
    await expect(table.locator('tbody [data-column="Tag"]').getByRole("button")).toHaveText([
        "direct",
        tag,
    ]);
    await table.getByRole("button", { name: tag, exact: true }).click();
    const fullTag = page.getByRole("dialog", { name: "Tag", exact: true });
    await expect(fullTag).toContainText(tag);
    await fullTag.getByRole("button", { name: "Close", exact: true }).last().click();
    await table.getByRole("button", { name: server, exact: true }).click();
    const address = page.getByRole("dialog", { name: "Address", exact: true });
    await expect(address).toContainText(server);
    await address.getByRole("button", { name: "Close", exact: true }).last().click();
    const more = page.getByRole("button", { name: `More actions for ${tag}`, exact: true });
    await more.click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit Outbound", exact: true });
    await expect(edit.getByLabel("Tag", { exact: true })).toHaveValue(tag);
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await more.click();
    await page.getByRole("menuitem", { name: "Traffic chart", exact: true }).click();
    const traffic = page.getByRole("dialog", { name: "Traffic", exact: true });
    await expect(traffic).toContainText(tag);
    await traffic.getByRole("button", { name: "Close", exact: true }).last().click();
    await more.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const question = page.getByRole("alertdialog", { name: "Delete", exact: true });
    await expect(question).toContainText(tag);
    await expect(question.getByRole("button", { name: "No", exact: true })).toBeFocused();
    await question.getByRole("button", { name: "No", exact: true }).click();
    await expect(more).toBeFocused();
    expect(state.outbounds).toHaveLength(2);
    await page.screenshot({ path: "test-results/outbounds-list-mobile.png", fullPage: true });
});

test("keeps a failed deletion open for retry and protects the final outbound", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false };
    await mockApi(page, state);
    let attempts = 0;
    await page.route("**/api/outbounds/2", async (route) => {
        if (route.request().method() !== "DELETE") return route.fallback();
        if (++attempts > 1) return route.fallback();
        await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                success: false,
                msg: "The outbound could not be deleted.",
                obj: null,
            }),
        });
    });
    await page.goto("/outbounds");
    await page.getByRole("button", { name: "Sort by Tag", exact: true }).click();
    const remove = page.getByRole("button", { name: "Delete upstream", exact: true });
    await remove.click();
    const question = page.getByRole("alertdialog", { name: "Delete", exact: true });
    await question.getByRole("button", { name: "No", exact: true }).click();
    await expect(remove).toBeFocused();
    await remove.click();
    await question.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(question).toContainText("The outbound could not be deleted.");
    await expect(
        page.locator('tbody [data-column="Tag"]').filter({ hasText: "upstream" }),
    ).toHaveCount(1);
    expect(state.outbounds).toHaveLength(2);
    await question.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(question).toBeHidden();
    await expect(page.getByRole("button", { name: "Add Outbound", exact: true })).toBeFocused();
    expect(state.outbounds?.map((outbound) => outbound.tag)).toEqual(["out"]);
    await page.getByRole("button", { name: "Delete out", exact: true }).click();
    await expect(question).toContainText("This is the only outbound");
    await expect(question.getByRole("button", { name: "Yes", exact: true })).toBeDisabled();
    expect(attempts).toBe(2);
});
