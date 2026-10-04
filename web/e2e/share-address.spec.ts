import { expect, test, type Page } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

const firstAddress = {
    server: "node.example.com",
    server_port: 8443,
    remark: "-edge",
    tls: { server_name: "sni.example.com" },
};
const backupAddress = { server: "backup.example.com", server_port: 9443, remark: "-backup" };

const listener = (addrs?: unknown[]) => ({
    id: 1,
    type: "vless",
    tag: "edge",
    listen: "::",
    listen_port: 56123,
    transport: { type: "ws", path: "/proxy" },
    out_json: { tls: { utls: { enabled: true, fingerprint: "chrome" } } },
    ...(addrs ? { addrs } : {}),
});

const editListener = async (page: Page, tag = "edge") => {
    await page.getByLabel(`Edit ${tag}`, { exact: true }).click();

    return page.getByRole("dialog", { name: "Edit listener" });
};

test("creates a listener with an optional empty share address", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    await page.getByRole("button", { name: "Add inbound" }).click();
    const dialog = page.getByRole("dialog", { name: "Add inbound" });

    await dialog.getByLabel("Type").selectOption("vless");
    await dialog.getByLabel("Tag", { exact: true }).fill("automatic");
    await dialog.getByLabel("Port", { exact: true }).fill("56123");
    await expect(dialog.getByLabel("Share address", { exact: true })).toHaveValue("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect(dialog).toBeHidden();
    expect(state.inbounds?.[0]).toMatchObject({ listen: "::", listen_port: 56123 });
    expect(state.inbounds?.[0]).not.toHaveProperty("addrs");
    expect(state.inbounds?.[0]).not.toHaveProperty("share_address");
});

test("saves a domain with the entered port and reads it back", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    await page.getByRole("button", { name: "Add inbound" }).click();
    const dialog = page.getByRole("dialog", { name: "Add inbound" });

    await dialog.getByLabel("Type").selectOption("vless");
    await dialog.getByLabel("Tag", { exact: true }).fill("shared");
    await dialog.getByLabel("Port", { exact: true }).fill("56123");
    await dialog.getByLabel("Share address", { exact: true }).fill("  Node.Example.com  ");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(state.inbounds?.[0]).toMatchObject({
        listen: "::",
        listen_port: 56123,
        addrs: [{ server: "node.example.com", server_port: 56123 }],
    });
    expect(state.inbounds?.[0]).not.toHaveProperty("share_address");

    await page.reload();
    const reopened = await editListener(page, "shared");
    await expect(reopened.getByLabel("Share address", { exact: true })).toHaveValue(
        "node.example.com",
    );
    await expect(reopened.getByLabel("Port", { exact: true })).toHaveValue("56123");
});

test("preserves legacy publications when changing an unrelated field", async ({ page }) => {
    const original = listener([firstAddress, backupAddress]);
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [original] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    const dialog = await editListener(page);

    await expect(dialog.getByLabel("Share address", { exact: true })).toHaveValue(
        "node.example.com",
    );
    await dialog.getByLabel("Tag", { exact: true }).fill("renamed");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(state.inbounds?.[0]).toEqual({ ...original, tag: "renamed" });
});

test("updates the publication port while preserving the other addresses and options", async ({
    page,
}) => {
    const original = listener([firstAddress, backupAddress]);
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [original] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    const dialog = await editListener(page);

    await dialog.getByLabel("Port", { exact: true }).fill("23456");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(state.inbounds?.[0]).toEqual({
        ...original,
        listen_port: 23456,
        addrs: [{ ...firstAddress, server_port: 23456 }, backupAddress],
    });
    await page.reload();
    const reopened = await editListener(page);
    await expect(reopened.getByLabel("Port", { exact: true })).toHaveValue("23456");
});

test("changes the domain using the current port without changing TLS overrides", async ({
    page,
}) => {
    const original = listener([firstAddress, backupAddress]);
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [original] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    const dialog = await editListener(page);

    await dialog.getByLabel("Share address", { exact: true }).fill("new.example.com");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    expect(state.inbounds?.[0]).toEqual({
        ...original,
        addrs: [{ ...firstAddress, server: "new.example.com", server_port: 56123 }, backupAddress],
    });
});

test("clears the last share address and leaves the form empty after reload", async ({ page }) => {
    const original = listener([firstAddress]);
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [original] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    const dialog = await editListener(page);

    await dialog.getByLabel("Share address", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(state.inbounds?.[0]).toEqual({ ...original, addrs: [] });

    await page.reload();
    const reopened = await editListener(page);
    await expect(reopened.getByLabel("Share address", { exact: true })).toHaveValue("");
    await expect(reopened.getByLabel("Port", { exact: true })).toHaveValue("56123");
});

test("clears only the edited share address when other publications exist", async ({ page }) => {
    const original = listener([firstAddress, backupAddress]);
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [original] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    const dialog = await editListener(page);

    await dialog.getByLabel("Share address", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(state.inbounds?.[0]).toEqual({ ...original, addrs: [backupAddress] });
});

test("clones the shared domain onto the clone's new port", async ({ page }) => {
    const original = listener([firstAddress, backupAddress]);
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [original] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    await page.getByLabel("Clone edge", { exact: true }).click();
    await expect(page.getByRole("list", { name: "Listeners" }).getByRole("listitem")).toHaveCount(
        2,
    );

    const copy = state.inbounds?.[1];
    expect(copy?.listen_port).toBeGreaterThanOrEqual(10000);
    expect(copy?.listen_port).toBeLessThanOrEqual(60000);
    expect(copy?.addrs).toEqual([
        { ...firstAddress, server_port: copy?.listen_port },
        backupAddress,
    ]);
    expect(copy?.out_json).toEqual(original.out_json);
    expect(state.inbounds?.[0]).toEqual(original);
});

test("rejects a URL, an embedded port and a missing port before saving", async ({ page }) => {
    const state: ApiState = { signedIn: true, maintenance: false, inbounds: [] };
    await mockApi(page, state);
    await page.goto("/inbounds");
    await page.getByRole("button", { name: "Add inbound" }).click();
    const dialog = page.getByRole("dialog", { name: "Add inbound" });
    await dialog.getByLabel("Type").selectOption("vless");
    await dialog.getByLabel("Tag", { exact: true }).fill("invalid");
    await dialog.getByLabel("Port", { exact: true }).fill("56123");

    for (const value of ["https://node.example.com", "node.example.com:56123", "45.32.93.251"]) {
        await dialog.getByLabel("Share address", { exact: true }).fill(value);
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toContainText("Enter a domain only, without a scheme, port or path.");
        expect(state.inbounds).toEqual([]);
    }

    await dialog.getByLabel("Share address", { exact: true }).fill("node.example.com");
    await dialog.getByLabel("Port", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toContainText("Enter a port from 1 to 65535.");
    expect(state.inbounds).toEqual([]);
});

test("offers the share address for all published protocols including Snell", async ({ page }) => {
    await mockApi(page, { signedIn: true, maintenance: false });
    await page.goto("/inbounds");
    await page.getByRole("button", { name: "Add inbound" }).click();
    const dialog = page.getByRole("dialog", { name: "Add inbound" });

    for (const type of [
        "socks",
        "http",
        "mixed",
        "shadowsocks",
        "naive",
        "hysteria",
        "hysteria2",
        "anytls",
        "tuic",
        "vless",
        "trojan",
        "vmess",
        "snell",
    ]) {
        await dialog.getByLabel("Type").selectOption(type);
        await expect(dialog.getByLabel("Share address", { exact: true })).toBeVisible();
    }
    for (const type of ["tun", "cloudflared", "direct", "redirect", "tproxy", "shadowtls"]) {
        await dialog.getByLabel("Type").selectOption(type);
        await expect(dialog.getByLabel("Share address", { exact: true })).toHaveCount(0);
    }
});

test("keeps the share address form readable on desktop and mobile", async ({ page }, testInfo) => {
    await mockApi(page, { signedIn: true, maintenance: false, inbounds: [listener()] });
    await page.goto("/inbounds");
    const dialog = await editListener(page);
    await dialog.getByLabel("Share address", { exact: true }).fill("node.example.com");
    await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("56123");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width,
    );
    await dialog.screenshot({ path: testInfo.outputPath("share-address-form.png") });
});
