import { expect, test, type Page } from "@playwright/test";

import { client, mockApi, type ApiState } from "./fixtures/api";

const openClients = async (page: Page) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        clients: Array.from({ length: 100 }, (_, index) => ({
            ...client,
            id: index + 1,
            name: `client-${String(index + 1).padStart(3, "0")}`,
        })),
        outbounds: [{ id: 1, type: "direct", tag: "out" }],
        baseConfig: { route: { rules: [] } },
    };

    await mockApi(page, state);
    await page.goto("/rules");
    await page.getByRole("button", { name: "Add rule", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Add rule", exact: true });
    await dialog.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    await dialog.getByLabel("Outbound", { exact: true }).selectOption("out");
    await dialog.getByRole("button", { name: "Rule options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Clients", exact: true }).click();
    await page.keyboard.press("Escape");

    const trigger = dialog.getByRole("button", { name: /^Clients/ });
    await trigger.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(100);

    return { state, dialog, trigger, menu };
};

for (const viewport of [
    { name: "desktop", width: 1280, height: 720 },
    { name: "short window", width: 900, height: 360 },
]) {
    test(`scrolls and saves a long Clients selection in a ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const { state, dialog, trigger, menu } = await openClients(page);
        await expect(menu).toBeInViewport({ ratio: 1 });

        const first = menu.getByRole("menuitemcheckbox", { name: "client-001", exact: true });
        const last = menu.getByRole("menuitemcheckbox", { name: "client-100", exact: true });
        await first.click();
        await expect(first).toHaveAttribute("aria-checked", "true");

        const dialogScroll = () =>
            dialog.evaluate((element) =>
                Array.from(element.querySelectorAll<HTMLElement>("*")).map(
                    (child) => child.scrollTop,
                ),
            );
        const beforeScroll = await dialogScroll();
        const box = await menu.boundingBox();
        if (!box) throw new Error("Clients menu has no visible bounds");

        // Wheel input must reach the list itself, without Playwright bringing
        // the last option into view on behalf of a user who cannot reach it.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 10_000);
        await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expect(last).toBeInViewport({ ratio: 1 });
        await page.mouse.wheel(0, 10_000);
        await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
        expect(await dialogScroll()).toEqual(beforeScroll);

        await last.click();
        await expect(last).toHaveAttribute("aria-checked", "true");
        await expect(menu).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(dialog).toBeVisible();
        await expect(trigger).toBeFocused();
        await expect(trigger).toContainText("client-001");
        await expect(trigger).toContainText("client-100");

        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        expect(state.baseConfig?.route).toMatchObject({
            rules: [{ auth_user: ["client-001", "client-100"], action: "route", outbound: "out" }],
        });
    });
}

test("resizes an open Clients list and keeps keyboard selections visible", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { dialog, trigger, menu } = await openClients(page);
    await expect(menu).toBeInViewport({ ratio: 1 });

    await page.setViewportSize({ width: 900, height: 360 });
    await expect(menu).toBeInViewport({ ratio: 1 });
    const first = menu.getByRole("menuitemcheckbox", { name: "client-001", exact: true });
    const last = menu.getByRole("menuitemcheckbox", { name: "client-100", exact: true });
    await first.focus();
    await page.keyboard.press("End");
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    await expect(first).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Space");
    await expect(first).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeFocused();
});
