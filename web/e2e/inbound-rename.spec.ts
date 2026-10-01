import { expect, test } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

test("renames an existing listener while retaining its id and unmodelled options", async ({
    page,
}) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        inbounds: [
            {
                id: 7,
                type: "socks",
                tag: "edge",
                listen: "127.0.0.1",
                listen_port: 1080,
                tcp_fast_open: true,
                custom_option: { value: "preserve" },
            },
        ],
    };

    await mockApi(page, state);
    await page.goto("/inbounds");
    await page.getByLabel("Edit edge", { exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Edit listener" });
    const tag = dialog.getByLabel("Tag", { exact: true });

    await expect(tag).toBeEnabled();
    await tag.fill("two words");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toContainText("Use no spaces.");
    await tag.fill("edge-renamed");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "edge-renamed", exact: true })).toBeVisible();
    expect(state.inbounds).toEqual([
        expect.objectContaining({
            id: 7,
            tag: "edge-renamed",
            type: "socks",
            listen: "127.0.0.1",
            listen_port: 1080,
            tcp_fast_open: true,
            custom_option: { value: "preserve" },
        }),
    ]);
});

test("keeps the edit dialog open when the new tag is already taken", async ({ page }) => {
    const state: ApiState = {
        signedIn: true,
        maintenance: false,
        inbounds: [
            { id: 1, type: "socks", tag: "edge", listen: "::", listen_port: 1080 },
            { id: 2, type: "socks", tag: "taken", listen: "::", listen_port: 1081 },
        ],
    };

    await mockApi(page, state);
    await page.goto("/inbounds");
    await page.getByLabel("Edit edge", { exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Edit listener" });

    await dialog.getByLabel("Tag", { exact: true }).fill("taken");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toContainText("a listener with that tag already exists");
    expect(state.inbounds?.map((inbound) => inbound.tag)).toEqual(["edge", "taken"]);
});
