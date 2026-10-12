import { expect, test, type Page } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

interface DnsDocument {
    servers: { type: string; tag: string; server?: string; [option: string]: unknown }[];
    rules: { action?: string; server?: string; [option: string]: unknown }[];
    final?: string;
    [option: string]: unknown;
}

const dnsState = (): ApiState => ({
    signedIn: true,
    maintenance: false,
    baseConfig: {
        log: { level: "info" },
        route: { rule_set: [{ type: "local", tag: "ads", path: "/etc/ads.srs" }] },
        dns: {
            experimental_option: { keep: true },
            servers: [
                { type: "local", tag: "z-local" },
                {
                    type: "tls",
                    tag: "a-secure",
                    server: "2001:4860:4860::8888",
                    server_port: 853,
                    tls: { enabled: true, server_name: "dns.google" },
                },
                {
                    type: "udp",
                    tag: "b-plain",
                    server: "1.1.1.1",
                    server_port: 53,
                    tls: { enabled: false },
                },
            ],
            rules: [
                {
                    domain_suffix: [".cn"],
                    server: "z-local",
                    strategy: "prefer_ipv4",
                    rewrite_ttl: 120,
                    client_subnet: "192.0.2.0/24",
                },
                { query_type: ["HTTPS"], action: "reject", method: "drop" },
                {
                    type: "logical",
                    mode: "and",
                    rules: [{ rule_set: ["ads"] }, { ip_is_private: true }],
                    action: "route",
                    server: "a-secure",
                    invert: true,
                    disable_cache: true,
                },
            ],
        },
    },
});

const dnsIn = (state: ApiState) => state.baseConfig?.dns as DnsDocument;
const serversTable = (page: Page) => page.getByRole("table", { name: "DNS servers", exact: true });
const rulesTable = (page: Page) => page.getByRole("table", { name: "DNS rules", exact: true });
const actions = (page: Page) => rulesTable(page).locator('tbody [data-column="Action"]');

test.describe("DNS lists", () => {
    test("shows compact tables in document order with DNS-specific condition counts", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        const state = dnsState();
        dnsIn(state).rules[2].server = "removed-server";
        await mockApi(page, state);
        await page.goto("/dns");
        await expect(serversTable(page)).toHaveAttribute("aria-busy", "false", { timeout: 15000 });

        await expect(serversTable(page).getByRole("columnheader")).toHaveText([
            "Tag",
            "Type",
            "Server",
            "Port",
            "TLS",
            "Actions",
        ]);
        await expect(rulesTable(page).getByRole("columnheader")).toHaveText([
            "Order",
            "Type",
            "Action",
            "Server",
            "Conditions",
            "Invert",
            "Actions",
        ]);
        await expect(serversTable(page).locator('tbody [data-column="Tag"]')).toHaveText(
            ["z-local", "a-secure", "b-plain"],
            { useInnerText: true },
        );
        await expect(serversTable(page).locator('tbody [data-column="TLS"]')).toHaveText(
            ["—", "Enabled", "Disabled"],
            { useInnerText: true },
        );
        await expect(rulesTable(page).locator('tbody [data-column="Conditions"]')).toHaveText([
            "1 condition",
            "1 condition",
            "2 subrules",
        ]);
        await expect(actions(page)).toHaveText(["route", "reject", "route"], {
            useInnerText: true,
        });
        await expect(rulesTable(page).locator('tbody [data-column="Server"]').last()).toContainText(
            "missing",
        );
        await expect(page.getByLabel("Final", { exact: true })).toHaveValue("");
        await expect(serversTable(page).getByRole("button", { name: /^Sort by/ })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        expect(
            await serversTable(page)
                .locator("tbody > tr")
                .first()
                .evaluate((row) => row.getBoundingClientRect().height),
        ).toBeLessThanOrEqual(60);
        await page.screenshot({ path: "test-results/dns-list-desktop.png", fullPage: true });
    });

    test("moves rules with the keyboard and edits the moved rule before saving", async ({
        page,
    }) => {
        const state = dnsState();
        await mockApi(page, state);
        await page.goto("/dns");
        await page
            .getByRole("button", { name: "More actions for rule 1", exact: true })
            .press("Enter");
        await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await page
            .getByRole("button", { name: "More actions for rule 3", exact: true })
            .press("Enter");
        await expect(page.getByRole("menuitem", { name: "Move down", exact: true })).toBeDisabled();
        await page.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter");
        await expect(actions(page)).toHaveText(["route", "route", "reject"], {
            useInnerText: true,
        });
        await expect(
            page.getByRole("button", { name: "More actions for rule 2", exact: true }),
        ).toBeFocused();
        await expect(page.getByRole("menu")).toHaveCount(0);
        expect(dnsIn(state).rules.map((rule) => rule.action)).toEqual([
            undefined,
            "reject",
            "route",
        ]);

        await page.getByRole("button", { name: "More actions for rule 1", exact: true }).click();
        await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
        await page.getByRole("button", { name: "Edit rule 1", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Edit DNS rule", exact: true });
        await expect(dialog.getByLabel("Mode", { exact: true })).toHaveValue("and");
        await dialog.getByLabel("Server", { exact: true }).selectOption("b-plain");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        expect(dnsIn(state).rules[0]).toMatchObject({ type: "logical", server: "b-plain" });
        expect(dnsIn(state).rules[1]).toMatchObject({
            server: "z-local",
            strategy: "prefer_ipv4",
            rewrite_ttl: 120,
            client_subnet: "192.0.2.0/24",
        });
        expect(dnsIn(state).experimental_option).toEqual({ keep: true });
        expect(state.baseConfig?.log).toEqual({ level: "info" });
        expect(state.baseConfig?.route).toEqual({
            rule_set: [{ type: "local", tag: "ads", path: "/etc/ads.srs" }],
        });
        await page.reload();
        await expect(actions(page)).toHaveText(["route", "route", "reject"], {
            useInnerText: true,
        });
        await expect(rulesTable(page).locator('tbody [data-column="Order"]')).toHaveText([
            "1",
            "2",
            "3",
        ]);
        await expect(rulesTable(page).locator('tbody [data-column="Server"]').first()).toHaveText(
            "b-plain",
            { useInnerText: true },
        );
    });

    test("returns focus after canceling an edit and saves a server without changing its order", async ({
        page,
    }) => {
        const state = dnsState();
        await mockApi(page, state);
        await page.goto("/dns");
        const trigger = page.getByRole("button", { name: "Edit a-secure", exact: true });
        await trigger.click();
        const dialog = page.getByRole("dialog", { name: "Edit DNS server", exact: true });
        await dialog.getByLabel("Address", { exact: true }).fill("2001:4860:4860::8844");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

        await trigger.click();
        await expect(dialog.getByLabel("Address", { exact: true })).toHaveValue(
            "2001:4860:4860::8888",
        );
        await dialog.getByLabel("Address", { exact: true }).fill("2001:4860:4860::8844");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        expect(dnsIn(state).servers[1].server).toBe("2001:4860:4860::8888");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        expect(dnsIn(state).servers.map((server) => server.tag)).toEqual([
            "z-local",
            "a-secure",
            "b-plain",
        ]);
        expect(dnsIn(state).servers[1]).toMatchObject({
            server: "2001:4860:4860::8844",
            tls: { enabled: true, server_name: "dns.google" },
        });
    });

    test("keeps Final and rule references visible when their server is deleted", async ({
        page,
    }) => {
        const state = dnsState();
        dnsIn(state).final = "a-secure";
        await mockApi(page, state);
        await page.goto("/dns");
        const trigger = page.getByRole("button", { name: "Delete a-secure", exact: true });
        await trigger.click();
        const dialog = page.getByRole("alertdialog", { name: "Delete", exact: true });
        await expect(dialog.getByRole("button", { name: "No", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

        await trigger.click();
        await dialog.getByRole("button", { name: "Yes", exact: true }).click();
        await expect(
            page.getByRole("button", { name: "Add DNS server", exact: true }),
        ).toBeFocused();
        await expect(page.getByLabel("Final", { exact: true })).toHaveValue("a-secure");
        await expect(
            page.getByLabel("Final", { exact: true }).locator("option:checked"),
        ).toHaveText("a-secure — no longer exists");
        await expect(rulesTable(page).locator('tbody [data-column="Server"]').last()).toContainText(
            "missing",
        );
        expect(dnsIn(state).servers).toHaveLength(3);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        expect(dnsIn(state).servers).toHaveLength(2);
        expect(dnsIn(state).final).toBe("a-secure");
        expect(dnsIn(state).rules[2].server).toBe("a-secure");
    });

    test("cancels a rule deletion, then deletes only the selected rule in the draft", async ({
        page,
    }) => {
        const state = dnsState();
        await mockApi(page, state);
        await page.goto("/dns");
        const trigger = page.getByRole("button", { name: "Delete rule 2", exact: true });
        await trigger.click();
        const dialog = page.getByRole("alertdialog", { name: "Delete", exact: true });
        await expect(dialog).toContainText("rule 2");
        await dialog.getByRole("button", { name: "No", exact: true }).click();
        await expect(trigger).toBeFocused();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "More actions for rule 2", exact: true }).click();
        await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
        await dialog.getByRole("button", { name: "Yes", exact: true }).click();
        await expect(actions(page)).toHaveText(["route", "route"], { useInnerText: true });
        await expect(page.getByRole("button", { name: "Add DNS rule", exact: true })).toBeFocused();
        expect(dnsIn(state).rules).toHaveLength(3);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        expect(dnsIn(state).rules.map((rule) => rule.server)).toEqual(["z-local", "a-secure"]);
    });

    test("shows empty lists after loading an empty document", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false, baseConfig: {} });
        await page.goto("/dns");
        await expect(serversTable(page)).toContainText("No DNS servers yet.");
        await expect(rulesTable(page)).toContainText("No DNS rules yet.");
        await expect(
            page.getByRole("button", { name: "Add DNS server", exact: true }),
        ).toBeEnabled();
        await expect(page.getByRole("button", { name: "Add DNS rule", exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    });

    test("waits for the document before enabling changes or showing empty states", async ({
        page,
    }) => {
        await mockApi(page, dnsState());
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route("**/api/config/base", async (route) => {
            await ready;
            await route.fallback();
        });
        try {
            await page.goto("/dns");
            await expect(serversTable(page)).toHaveAttribute("aria-busy", "true");
            await expect(rulesTable(page)).toHaveAttribute("aria-busy", "true");
            await expect(
                page.getByRole("button", { name: "Add DNS server", exact: true }),
            ).toBeDisabled();
            await expect(
                page.getByRole("button", { name: "Add DNS rule", exact: true }),
            ).toBeDisabled();
            await expect(page.getByText("No DNS servers yet.", { exact: true })).toBeHidden();
            await expect(page.getByText("No DNS rules yet.", { exact: true })).toBeHidden();
        } finally {
            release();
        }
        await expect(actions(page)).toHaveText(["route", "reject", "route"], {
            useInnerText: true,
        });
        await expect(serversTable(page)).toHaveAttribute("aria-busy", "false");
    });

    test("reports a failed read without presenting an empty editable document", async ({
        page,
    }) => {
        await mockApi(page, dnsState());
        await page.route("**/api/config/base", (route) =>
            route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({ success: false, msg: "Cannot load DNS", obj: null }),
            }),
        );
        await page.goto("/dns");
        await expect(page.getByText("Cannot load DNS", { exact: true })).toBeVisible();
        await expect(page.getByText("No DNS servers yet.", { exact: true })).toBeHidden();
        await expect(page.getByText("No DNS rules yet.", { exact: true })).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Add DNS server", exact: true }),
        ).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "Add DNS rule", exact: true }),
        ).toBeDisabled();
    });

    test("keeps reordered rules in the draft when saving fails", async ({ page }) => {
        const state = dnsState();
        await mockApi(page, state);
        await page.route("**/api/config/base", (route) =>
            route.request().method() === "POST"
                ? route.fulfill({
                      status: 400,
                      contentType: "application/json",
                      body: JSON.stringify({ success: false, msg: "DNS save failed", obj: null }),
                  })
                : route.fallback(),
        );
        await page.goto("/dns");
        await page.getByRole("button", { name: "More actions for rule 3", exact: true }).click();
        await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByText("DNS save failed", { exact: true })).toBeVisible();
        await expect(actions(page)).toHaveText(["route", "route", "reject"], {
            useInnerText: true,
        });
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        expect(dnsIn(state).rules.map((rule) => rule.action)).toEqual([
            undefined,
            "reject",
            "route",
        ]);
    });

    test.describe("on a phone", () => {
        test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

        test("opens full tags and addresses and moves and deletes through menus", async ({
            page,
        }) => {
            const state = dnsState();
            const longTag = `resolver-${"long-name-".repeat(12)}`;
            const address = "2001:4860:4860:1234:abcd:ef12:3456:7890";
            dnsIn(state).servers[1].tag = longTag;
            dnsIn(state).servers[1].server = address;
            dnsIn(state).rules[2].server = longTag;
            await mockApi(page, state);
            await page.goto("/dns");
            await expect(serversTable(page).getByRole("columnheader")).toHaveCount(0);
            await expect(rulesTable(page).getByRole("columnheader")).toHaveCount(0);
            await serversTable(page).getByRole("button", { name: longTag, exact: true }).tap();
            const tagDetail = page.getByRole("dialog", { name: "DNS server tag", exact: true });
            await expect(tagDetail).toContainText(longTag);
            await tagDetail.getByRole("button", { name: "Close", exact: true }).first().tap();
            await serversTable(page).getByRole("button", { name: address, exact: true }).tap();
            const addressDetail = page.getByRole("dialog", {
                name: "DNS server address",
                exact: true,
            });
            await expect(addressDetail).toContainText(address);
            await addressDetail.getByRole("button", { name: "Close", exact: true }).first().tap();
            await rulesTable(page).getByRole("button", { name: longTag, exact: true }).tap();
            const serverDetail = page.getByRole("dialog", {
                name: "Server for rule 3",
                exact: true,
            });
            await expect(serverDetail).toContainText(longTag);
            await serverDetail.getByRole("button", { name: "Close", exact: true }).first().tap();

            await page.getByRole("button", { name: "More actions for rule 3", exact: true }).tap();
            await page.getByRole("menuitem", { name: "Move up", exact: true }).tap();
            await expect(actions(page)).toHaveText(
                ["Action route", "Action route", "Action reject"],
                {
                    useInnerText: true,
                },
            );
            const menuTrigger = page.getByRole("button", {
                name: "More actions for b-plain",
                exact: true,
            });
            await menuTrigger.tap();
            await page.getByRole("menuitem", { name: "Delete", exact: true }).tap();
            const question = page.getByRole("alertdialog", { name: "Delete", exact: true });
            await question.getByRole("button", { name: "No", exact: true }).tap();
            await expect(menuTrigger).toBeFocused();
            await menuTrigger.tap();
            await page.getByRole("menuitem", { name: "Delete", exact: true }).tap();
            await question.getByRole("button", { name: "Yes", exact: true }).tap();
            await expect(
                page.getByRole("button", { name: "Edit b-plain", exact: true }),
            ).toHaveCount(0);
            expect(dnsIn(state).servers).toHaveLength(3);
            await page.getByRole("button", { name: "Save", exact: true }).tap();
            await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
            expect(dnsIn(state).servers).toHaveLength(2);
            await page.reload();
            await expect(actions(page)).toHaveText(
                ["Action route", "Action route", "Action reject"],
                {
                    useInnerText: true,
                },
            );
            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= window.innerWidth,
                ),
            ).toBe(true);
            await page.screenshot({ path: "test-results/dns-list-mobile.png", fullPage: true });
        });
    });
});
