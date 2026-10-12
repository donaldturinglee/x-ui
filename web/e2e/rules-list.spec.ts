import { expect, test, type Page } from "@playwright/test";

import { mockApi, type ApiState } from "./fixtures/api";

const routingState = (): ApiState => ({
    signedIn: true,
    maintenance: false,
    outbounds: [
        { id: 1, tag: "out", type: "direct" },
        { id: 2, tag: "upstream", type: "socks", server: "example.com", server_port: 1080 },
    ],
    baseConfig: {
        log: { level: "info" },
        route: {
            final: "upstream",
            rules: [
                { action: "sniff" },
                { action: "reject", rule_set: ["geosite-ads"] },
                {
                    type: "logical",
                    mode: "or",
                    rules: [{ domain_suffix: [".cn"] }, { ip_is_private: true }],
                    action: "route",
                    outbound: "out",
                    invert: true,
                },
            ],
            rule_set: [
                {
                    type: "remote",
                    tag: "geosite-ads",
                    format: "binary",
                    url: "https://example.com/geosite-ads.srs",
                    http_client: { detour: "upstream" },
                    update_interval: "1d",
                },
                { type: "local", tag: "blocklist", format: "source", path: "/etc/blocklist.json" },
            ],
        },
    },
});

const rulesTable = (page: Page) => page.getByRole("table", { name: "Rules", exact: true });
const ruleSetsTable = (page: Page) => page.getByRole("table", { name: "Rule sets", exact: true });
const actions = (page: Page) => rulesTable(page).locator('tbody [data-column="Action"]');
const storedRules = (state: ApiState) =>
    (state.baseConfig?.route as { rules: { action: string; outbound?: string }[] }).rules;

test("shows compact tables, logical counts and missing outbound references", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const state = routingState();
    storedRules(state)[2].outbound = "removed-outbound";
    await mockApi(page, state);
    await page.goto("/rules");

    await expect(rulesTable(page).getByRole("columnheader")).toHaveText([
        "",
        "Type",
        "Action",
        "Outbound",
        "Conditions",
        "Invert",
        "Actions",
    ]);
    await expect(ruleSetsTable(page).getByRole("columnheader")).toHaveText([
        "Tag",
        "Type",
        "Format",
        "Outbound",
        "Update",
        "Actions",
    ]);
    await expect(rulesTable(page).locator('tbody [data-column="Conditions"]')).toHaveText([
        "0 conditions",
        "1 condition",
        "2 subrules",
    ]);
    await expect(rulesTable(page).locator('tbody [data-column="Invert"]')).toHaveText(
        ["No", "No", "Yes"],
        { useInnerText: true },
    );
    await expect(rulesTable(page).locator('tbody [data-column="Outbound"]').last()).toContainText(
        "missing",
    );
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(rulesTable(page).getByRole("button", { name: /^Sort by/ })).toHaveCount(0);
    expect(
        await rulesTable(page)
            .locator("tbody > tr")
            .first()
            .evaluate((row) => row.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(60);
    await page.screenshot({ path: "test-results/rules-list-desktop.png", fullPage: true });
});

test("moves rules with the keyboard and edits the moved rule before saving", async ({ page }) => {
    const state = routingState();
    await mockApi(page, state);
    await page.goto("/rules");

    await page.getByRole("button", { name: "More actions for rule 1", exact: true }).press("Enter");
    await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More actions for rule 3", exact: true }).press("Enter");
    await expect(page.getByRole("menuitem", { name: "Move down", exact: true })).toBeDisabled();
    await page.getByRole("menuitem", { name: "Move up", exact: true }).press("Enter");
    await expect(actions(page)).toHaveText(["sniff", "route", "reject"], { useInnerText: true });
    await expect(
        page.getByRole("button", { name: "More actions for rule 2", exact: true }),
    ).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(storedRules(state).map((rule) => rule.action)).toEqual(["sniff", "reject", "route"]);

    await page.getByRole("button", { name: "More actions for rule 1", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
    await expect(actions(page)).toHaveText(["route", "sniff", "reject"], { useInnerText: true });
    await page.getByRole("button", { name: "Edit rule 1", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit rule", exact: true });
    await expect(dialog.getByLabel("Mode", { exact: true })).toHaveValue("or");
    await dialog.getByLabel("Outbound", { exact: true }).selectOption("upstream");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(storedRules(state)).toHaveLength(3);
    expect(storedRules(state)[0]).toMatchObject({ action: "route", outbound: "upstream" });
    await page.reload();
    await expect(actions(page)).toHaveText(["route", "sniff", "reject"], { useInnerText: true });
    await expect(rulesTable(page).locator('tbody [data-column="Order"]')).toHaveText(["", "", ""]);
});

test("cancels deletion and returns focus, then deletes only the selected rule in the draft", async ({
    page,
}) => {
    const state = routingState();
    await mockApi(page, state);
    await page.goto("/rules");
    const trigger = page.getByRole("button", { name: "Delete rule 2", exact: true });
    await trigger.click();
    const dialog = page.getByRole("alertdialog", { name: "Delete", exact: true });
    await expect(dialog).toContainText("rule 2");
    await expect(dialog.getByRole("button", { name: "No", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(actions(page)).toHaveText(["sniff", "reject", "route"], { useInnerText: true });
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "More actions for rule 2", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await dialog.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(actions(page)).toHaveText(["sniff", "route"], { useInnerText: true });
    await expect(page.getByRole("button", { name: "Add rule", exact: true })).toBeFocused();
    expect(storedRules(state)).toHaveLength(3);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(storedRules(state).map((rule) => rule.action)).toEqual(["sniff", "route"]);
});

test("shows empty lists with an enabled add button", async ({ page }) => {
    await mockApi(page, {
        signedIn: true,
        maintenance: false,
        baseConfig: { route: { rules: [], rule_set: [] } },
    });
    await page.goto("/rules");
    await expect(rulesTable(page)).toContainText("No rules yet.");
    await expect(ruleSetsTable(page)).toContainText("No rule sets yet.");
    await expect(page.getByRole("button", { name: "Add rule", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("waits for the base document before enabling edits or showing empty states", async ({
    page,
}) => {
    await mockApi(page, routingState());
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
        release = resolve;
    });
    await page.route("**/api/config/base", async (route) => {
        await ready;
        await route.fallback();
    });
    try {
        await page.goto("/rules");
        await expect(rulesTable(page)).toHaveAttribute("aria-busy", "true");
        await expect(ruleSetsTable(page)).toHaveAttribute("aria-busy", "true");
        await expect(page.getByRole("button", { name: "Add rule", exact: true })).toBeDisabled();
        await expect(page.getByText("No rules yet.", { exact: true })).toBeHidden();
    } finally {
        release();
    }
    await expect(actions(page)).toHaveText(["sniff", "reject", "route"], { useInnerText: true });
    await expect(rulesTable(page)).toHaveAttribute("aria-busy", "false");
});

test("reports a failed read without presenting an empty editable document", async ({ page }) => {
    await mockApi(page, routingState());
    await page.route("**/api/config/base", (route) =>
        route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ success: false, msg: "Cannot load routing", obj: null }),
        }),
    );
    await page.goto("/rules");
    await expect(page.getByText("Cannot load routing", { exact: true })).toBeVisible();
    await expect(page.getByText("No rules yet.", { exact: true })).toBeHidden();
    await expect(page.getByText("No rule sets yet.", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Add rule", exact: true })).toBeDisabled();
});

test("keeps the reordered draft when saving fails", async ({ page }) => {
    const state = routingState();
    await mockApi(page, state);
    await page.route("**/api/config/base", (route) =>
        route.request().method() === "POST"
            ? route.fulfill({
                  status: 400,
                  contentType: "application/json",
                  body: JSON.stringify({ success: false, msg: "Routing save failed", obj: null }),
              })
            : route.fallback(),
    );
    await page.goto("/rules");
    await page.getByRole("button", { name: "More actions for rule 3", exact: true }).click();
    await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Routing save failed", { exact: true })).toBeVisible();
    await expect(actions(page)).toHaveText(["sniff", "route", "reject"], { useInnerText: true });
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    expect(storedRules(state).map((rule) => rule.action)).toEqual(["sniff", "reject", "route"]);
});

test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test("shows full tags on tap and moves and deletes items through menus", async ({ page }) => {
        const state = routingState();
        const longOutbound = `proxy-${"long-name-".repeat(12)}`;
        const longRuleSet = `geosite-${"long-tag-".repeat(12)}`;
        state.outbounds![0].tag = longOutbound;
        storedRules(state)[2].outbound = longOutbound;
        (state.baseConfig?.route as { rule_set: { tag: string }[] }).rule_set[0].tag = longRuleSet;
        await mockApi(page, state);
        await page.goto("/rules");
        await expect(rulesTable(page).getByRole("columnheader")).toHaveCount(0);
        await rulesTable(page).getByRole("button", { name: longOutbound, exact: true }).tap();
        const detail = page.getByRole("dialog", { name: "Outbound for rule 3", exact: true });
        await expect(detail).toContainText(longOutbound);
        await detail.getByRole("button", { name: "Close", exact: true }).first().tap();
        await ruleSetsTable(page).getByRole("button", { name: longRuleSet, exact: true }).tap();
        const tagDetail = page.getByRole("dialog", { name: "Rule set tag", exact: true });
        await expect(tagDetail).toContainText(longRuleSet);
        await tagDetail.getByRole("button", { name: "Close", exact: true }).first().tap();

        await page.getByRole("button", { name: "More actions for rule 3", exact: true }).tap();
        await page.getByRole("menuitem", { name: "Move up", exact: true }).tap();
        await expect(actions(page)).toHaveText(["Action sniff", "Action route", "Action reject"], {
            useInnerText: true,
        });
        await page.getByRole("button", { name: "Save", exact: true }).tap();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await page.reload();
        await expect(actions(page)).toHaveText(["Action sniff", "Action route", "Action reject"], {
            useInnerText: true,
        });

        const menuTrigger = page.getByRole("button", {
            name: "More actions for blocklist",
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
            ruleSetsTable(page).getByRole("button", { name: "Edit blocklist", exact: true }),
        ).toHaveCount(0);
        expect((state.baseConfig?.route as { rule_set: unknown[] }).rule_set).toHaveLength(2);
        await page.getByRole("button", { name: "Save", exact: true }).tap();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        expect((state.baseConfig?.route as { rule_set: unknown[] }).rule_set).toHaveLength(1);
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({ path: "test-results/rules-list-mobile.png", fullPage: true });
    });
});
