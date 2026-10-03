import { expect, test, type Locator, type Page } from "@playwright/test";

import { client, defaultSettings, mockApi, type ApiState } from "./fixtures/api";

// A dialog grows into place as it opens, so one is measured only once it has
// finished: part of the way in, every field in it is a little narrower than it
// is going to be.
const settled = (dialog: Locator) =>
    dialog.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );

// Credentials the panel draws itself, in the shapes the API mints its own in: a
// version 4 UUID, and a secret of 24 bytes written URL-safe.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32}$/;

test.describe("the panel", () => {
    test("shows what the host is doing", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");

        // One tile per reading, with the dials and the charts drawn from the
        // same poll as the figures beside them.
        await expect(page.getByRole("heading", { name: "CPU gauge" })).toBeVisible();
        await expect(page.getByText("13%")).toBeVisible();
        await expect(page.getByRole("heading", { name: "System info" })).toBeVisible();
        await expect(page.getByText("node-1")).toBeVisible();
        await expect(page.getByText("4 cores")).toBeVisible();
    });

    test("says a reading the host does not report is not zero", async ({ page }) => {
        // A host with no swap and a host using none of its swap look identical
        // on a dial and mean opposite things.
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");

        const swap = page.getByRole("heading", { name: "Swap gauge" }).locator("../..");

        await expect(swap.getByText("—")).toBeVisible();
    });

    test("says plainly when maintenance is on", async ({ page }) => {
        // Maintenance withholds every listener from the configuration nodes
        // fetch, so a panel in it is serving nobody.
        await mockApi(page, { signedIn: true, maintenance: true });

        await page.goto("/overview");

        const panel = page.getByRole("heading", { name: "Panel info" }).locator("../..");

        await expect(panel.getByText("Maintenance")).toBeVisible();
    });

    test("turns maintenance on, once it has been asked about", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");
        await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

        await page.getByRole("button", { name: "Turn maintenance on" }).click();

        // Asked about rather than done on the click: the effect is delayed by a
        // sync interval and is invisible from here.
        await expect(page.getByRole("alertdialog")).toContainText("no subscriber can connect");
        await page.getByRole("button", { name: "Turn on" }).click();

        // The badge in the app bar is driven by what the API says rather than by
        // what was clicked, so its appearing is the write having landed.
        await expect(page.getByRole("link", { name: "Maintenance" })).toBeVisible();
    });

    test("shows only the tiles an operator picked", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");
        await expect(page.getByRole("heading", { name: "Swap gauge" })).toBeVisible();

        await page.getByRole("button", { name: "Tiles" }).click();
        await page.getByRole("dialog").getByText("Swap gauge").click();
        await page.getByRole("button", { name: "Close" }).click();

        await expect(page.getByRole("heading", { name: "Swap gauge" })).toBeHidden();
        // Kept, so a panel set up once opens the same way tomorrow.
        await page.reload();
        await expect(page.getByRole("heading", { name: "Swap gauge" })).toBeHidden();
    });

    test("counts what the panel is holding", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");

        await page.getByRole("button", { name: "Counts" }).click();

        const counts = page.getByRole("table", { name: "Counts" });

        await expect(counts.getByRole("row").filter({ hasText: "Outbounds" })).toContainText("2");
    });

    test("lists subscribers with their quota", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");

        await expect(page.getByRole("heading", { name: "Clients" }).first()).toBeVisible();

        // Read off the table rather than the page: the group filter offers the
        // same names, and matching one of those would pass whatever the rows
        // said.
        const table = page.getByRole("table", { name: "Subscribers" });

        await expect(table.getByRole("cell", { name: "alice", exact: true })).toBeVisible();
        await expect(table.getByText("staff")).toBeVisible();
    });

    test("hands over a subscriber's connection links", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        await page.getByLabel("Connection links for alice").click();

        // This is what the product is for: a link a subscriber can paste into a
        // client application.
        await expect(page.getByText("vless://", { exact: false })).toBeVisible();

        // And the one worth handing over in the first place — the subscription
        // URL, which a client application polls for itself.
        await expect(page.getByText("https://sub.example.com/sub/alice")).toBeVisible();
    });

    test("edits a subscriber without a separate display alias", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };
        await mockApi(page, state);
        await page.goto("/clients");
        await page.getByLabel("Edit alice", { exact: true }).click();

        const dialog = page.getByRole("dialog");
        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("alice");
        await expect(dialog.getByLabel("Remark", { exact: true })).toHaveCount(0);
        await dialog.getByLabel("Description", { exact: true }).fill("Updated subscriber");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();

        await expect(dialog).toBeHidden();
        expect(state.clients?.[0]).toMatchObject({ name: "alice", desc: "Updated subscriber" });
        expect(state.clients?.[0]).not.toHaveProperty("remark");
    });

    test("lists the listeners a node serves", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");

        // Scoped to the listeners, and the tag matched whole: the certificate
        // providers below them are cards on the same page.
        const listeners = page.getByRole("list", { name: "Listeners" });

        await expect(listeners.getByRole("heading", { name: "edge", exact: true })).toBeVisible();
        await expect(listeners.getByText("443")).toBeVisible();
    });

    test("says who connects through a listener and whether anything has lately", async ({
        page,
    }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");

        const card = page
            .getByRole("list", { name: "Listeners" })
            .getByRole("listitem")
            .filter({ hasText: "edge" });
        const value = (term: string) =>
            card.locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");

        // Read off the subscribers rather than the listener, which the API
        // answers without them: alice names this one as hers. Who they are is
        // said by the count's tooltip rather than beside it.
        const clients = value("Clients").getByRole("button");

        await expect(clients).toHaveText("1");
        await expect(clients).toHaveAccessibleDescription("alice");
        // And it has moved traffic within the last few minutes.
        await expect(value("Online")).toHaveText("Online");
    });

    test("lays the listeners out six across on a wide screen", async ({ page }) => {
        // The reference's grid, which is what this page is drawn after: six cards
        // to a row at this width, as wide as one another, the seventh starting
        // the next row.
        await page.setViewportSize({ width: 1440, height: 900 });
        await mockApi(page, {
            signedIn: true,
            maintenance: false,
            inbounds: Array.from({ length: 7 }, (_, index) => ({
                id: index + 1,
                type: "vless",
                tag: `edge-${index + 1}`,
                listen_port: 443 + index,
            })),
        });

        await page.goto("/inbounds");

        const listeners = page.getByRole("list", { name: "Listeners" });
        const cards = listeners.getByRole("listitem");

        await expect(cards).toHaveCount(7);

        const boxes = await Promise.all(
            (await cards.all()).map(async (card) => (await card.boundingBox())!),
        );

        expect(new Set(boxes.slice(0, 6).map((box) => box.y)).size).toBe(1);
        expect(new Set(boxes.map((box) => Math.round(box.width))).size).toBe(1);
        expect(boxes[6].y).toBeGreaterThan(boxes[0].y + boxes[0].height);
        expect(boxes[6].x).toBe(boxes[0].x);

        // And the one way to add another is centred over them rather than off to
        // one side.
        const grid = (await listeners.boundingBox())!;
        const add = (await page.getByRole("button", { name: "Add inbound" }).boundingBox())!;

        expect(Math.abs(add.x + add.width / 2 - (grid.x + grid.width / 2))).toBeLessThan(1);
    });

    test("adds a listener", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        // Scoped to the dialog: the fields are labelled much as the rows of the
        // cards behind it are.
        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Type").selectOption("trojan");
        await expect(dialog.getByLabel("Address", { exact: true })).toHaveValue("::");
        await dialog.getByLabel("Tag").fill("relay");
        await dialog.getByLabel("Address", { exact: true }).fill("127.0.0.1");
        await dialog.getByLabel("Port", { exact: true }).fill("8443");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(page.getByText("relay")).toBeVisible();
        await expect(page.getByText("8443")).toBeVisible();
    });

    test("lays out the listener dialog as the reference does", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");
        // Named whole: a dialog too tall to show at once scrolls, and what it
        // scrolls is a region named for the dialog -- "Add inbound".
        const listen = dialog.getByRole("region", { name: "Listen", exact: true });
        const tls = dialog.getByRole("region", { name: "TLS" });

        // Where a listener binds is its own block, and how it is served one
        // more only for a type that can be served over TLS.
        await expect(listen).toBeVisible();
        await expect(tls).toHaveCount(0);

        await dialog.getByLabel("Type").selectOption("vless");
        await expect(tls.getByLabel("Security")).toHaveValue("none");
        await expect(
            dialog.getByRole("link", { name: "vless listener documentation" }),
        ).toHaveAttribute("href", "https://sing-box.sagernet.org/configuration/inbound/vless/");
        await expect(tls.getByRole("link", { name: "TLS documentation" })).toHaveAttribute(
            "href",
            "https://sing-box.sagernet.org/configuration/shared/tls/",
        );

        // A tun listener is an interface rather than a socket, so it binds
        // nothing and has nothing served over TLS.
        await tls.getByLabel("Security").selectOption("tls");
        await listen.getByLabel("Port", { exact: true }).fill("8443");
        await dialog.getByLabel("Type").selectOption("tun");
        await expect(listen).toHaveCount(0);
        await expect(tls).toHaveCount(0);

        // Three fields to a row, as the reference sets them.
        await dialog.getByLabel("Type").selectOption("vless");
        await settled(dialog);
        await expect(listen.getByLabel("Address", { exact: true })).toHaveValue("::");

        const type = (await dialog.getByLabel("Type").boundingBox())!;
        const tag = (await dialog.getByLabel("Tag").boundingBox())!;

        expect(Math.round(type.width)).toBe(Math.round(tag.width));
        expect(Math.round(type.width * 3 + 16)).toBe(
            Math.round((await listen.boundingBox())!.width),
        );
        // Tun cleared the port it cannot bind, and the TLS with it.
        await expect(listen.getByLabel("Port", { exact: true })).toHaveValue("");
        await expect(tls.getByLabel("Security")).toHaveValue("none");
        await expect(tls.getByLabel("Certificate file path")).toHaveCount(0);
    });

    test("switches listen options on in groups, and writes them with the listener", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Type").selectOption("mixed");
        await dialog.getByLabel("Tag").fill("local");
        await dialog.getByLabel("Port", { exact: true }).fill("1080");

        await dialog.getByRole("button", { name: "Listen options" }).click();
        await page.getByRole("menuitemcheckbox", { name: "TCP options" }).click();
        // The menu stays open for the next, and Escape puts away the menu alone.
        await page.getByRole("menuitemcheckbox", { name: "UDP options" }).click();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden();
        await expect(dialog).toBeVisible();

        await dialog.getByRole("switch", { name: "TCP Fast Open" }).press("Space");
        await dialog.getByLabel("UDP NAT expiration (minutes)").fill("10");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.inbounds?.find((inbound) => inbound.tag === "local")).toMatchObject({
            type: "mixed",
            listen: "::",
            listen_port: 1080,
            tcp_fast_open: true,
            tcp_multi_path: false,
            udp_fragment: false,
            udp_timeout: "10m",
        });
    });

    test("refuses a type only served over TLS served in the clear", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Type").selectOption("hysteria2");
        await dialog.getByLabel("Tag").fill("quic");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog.getByLabel("Security")).toHaveAccessibleDescription(
            "A hysteria2 listener is only served over TLS: choose TLS.",
        );

        // Nor is Reality served over QUIC.
        await dialog.getByLabel("Security").selectOption("reality");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog.getByLabel("Security")).toHaveAccessibleDescription(
            "A hysteria2 listener cannot be served over Reality: choose TLS.",
        );
        expect(state.inbounds?.some((inbound) => inbound.tag === "quic")).toBe(false);
    });

    test("keeps where a listener binds in its own fields", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByLabel("Edit edge", { exact: true }).click();

        const dialog = page.getByRole("dialog");

        // Read out of the record into fields of their own, so changing a port is
        // filling in a number rather than editing the options around it.
        await expect(dialog.getByLabel("Port", { exact: true })).toHaveValue("443");
        await expect(dialog.getByLabel("Address", { exact: true })).toHaveValue("");

        await dialog.getByLabel("Port", { exact: true }).fill("8443");
        await dialog.getByLabel("Address", { exact: true }).fill("127.0.0.1");
        await page.getByRole("button", { name: "Save" }).click();

        // Read back from the API rather than from the form.
        await page.reload();
        await page.getByLabel("Edit edge", { exact: true }).click();

        const reopened = page.getByRole("dialog");

        await expect(reopened.getByLabel("Port", { exact: true })).toHaveValue("8443");
        await expect(reopened.getByLabel("Address", { exact: true })).toHaveValue("127.0.0.1");
        // And they reached the API as keys of the record rather than buried in
        // the options the panel carries alongside them.
        expect(state.inbounds?.[0]).toMatchObject({ listen: "127.0.0.1", listen_port: 8443 });
    });

    test("puts where a listener binds on one line", async ({ page }) => {
        // A grown item is sized from its own content before the row is shared
        // out, and these two carry captions long enough that the second was
        // pushed onto a line of its own. Visible is not the same as beside, so
        // this measures rather than looks.
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");
        await page.getByLabel("Edit edge", { exact: true }).click();

        const dialog = page.getByRole("dialog");

        // Measured once the dialog has come to rest: the two boxes are read one
        // after the other, and a dialog still animating in moves between them.
        await settled(dialog);

        const listen = (await dialog.getByLabel("Address", { exact: true }).boundingBox())!;
        const port = (await dialog.getByLabel("Port", { exact: true }).boundingBox())!;

        // Overlapping rather than level: a number input and a text input do not
        // draw quite the same border, so their tops differ by a hair even side
        // by side. Stacked they would be a caption and a gap apart.
        expect(port.y).toBeLessThan(listen.y + listen.height);
        expect(listen.y).toBeLessThan(port.y + port.height);
        expect(listen.x).toBeLessThan(port.x);
    });

    test("says what the API refused rather than swallowing it", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");

        // The tag is already taken, which is the API's to refuse.
        await dialog.getByLabel("Type").selectOption("vless");
        await dialog.getByLabel("Tag").fill("edge");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog.getByText("already exists", { exact: false })).toBeVisible();
    });

    test("amends a listener without dropping the options it does not model", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByLabel("Edit edge", { exact: true }).click();

        // The transport block is nothing the panel has a field for -- nothing in
        // the dialog shows it at all -- and it has to come back untouched from an
        // edit that only changed the port.
        await page.getByRole("dialog").getByLabel("Port", { exact: true }).fill("8443");
        await page.getByRole("button", { name: "Save" }).click();

        await expect(page.getByText("8443")).toBeVisible();

        // Read off what the API is holding rather than out of the form, so this
        // is what the panel actually sent rather than what it had in hand. The
        // mock replaces the record instead of merging, so an option the panel
        // dropped is missing here.
        expect(state.inbounds?.[0]).toMatchObject({
            listen_port: 8443,
            transport: { type: "ws", path: "/sub" },
        });

        await page.reload();
        await page.getByLabel("Edit edge", { exact: true }).click();

        // The tag is not editable here, and it still has to reach the API or the
        // update would have been refused for want of one.
        await expect(page.getByRole("dialog").getByLabel("Tag")).toHaveValue("edge");
    });

    test("deletes a listener", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");
        await page.getByLabel("Delete edge", { exact: true }).click();

        // Asked on the card itself rather than over the page, and what it costs a
        // subscriber is said before it is done.
        const question = page
            .getByRole("list", { name: "Listeners" })
            .getByRole("listitem")
            .filter({ hasText: "edge" })
            .getByRole("alertdialog", { name: "Delete" });

        await expect(question).toContainText("one node short");
        await question.getByRole("button", { name: "Yes" }).click();

        await expect(
            page.getByRole("list", { name: "Listeners" }).getByRole("listitem"),
        ).toHaveCount(0);
    });

    test("leaves a listener be when asked not to delete it", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");

        const remove = page.getByLabel("Delete edge", { exact: true });

        await remove.click();

        // Opened on the way out rather than the way through, since what is asked
        // cannot be undone.
        const no = page.getByRole("alertdialog").getByRole("button", { name: "No" });

        await expect(no).toBeFocused();
        await no.click();

        await expect(page.getByRole("alertdialog")).toBeHidden();
        // Focus goes back to what asked, on a card that is still there.
        await expect(remove).toBeFocused();
        expect(state.inbounds).toHaveLength(1);

        // Escape is a no as well.
        await remove.click();
        await page.keyboard.press("Escape");

        await expect(page.getByRole("alertdialog")).toBeHidden();
        expect(state.inbounds).toHaveLength(1);
    });

    test("clones a listener onto a tag and a port of its own", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByLabel("Clone edge", { exact: true }).click();

        await expect(
            page.getByRole("list", { name: "Listeners" }).getByRole("listitem"),
        ).toHaveCount(2);

        // Written straight away with everything the original carries, including
        // the options the panel does not model, under a tag the API will take
        // and a port the node is not already binding.
        const copy = state.inbounds?.[1];

        expect(copy).toMatchObject({
            type: "vless",
            transport: { type: "ws", path: "/sub" },
            tls: { enabled: true, certificate_path: "/etc/cert.pem" },
        });
        expect(copy?.tag).toMatch(/^vless-[0-9A-Za-z]{3}$/);
        expect(copy?.listen_port).toBeGreaterThanOrEqual(10_000);
        expect(copy?.listen_port).toBeLessThanOrEqual(60_000);
    });

    test("shows when a listener's traffic went", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");
        await page.getByLabel("Traffic for edge", { exact: true }).click();

        const dialog = page.getByRole("dialog");

        await expect(dialog).toContainText("edge");
        await expect(dialog.getByText("over the last 6 hours")).toBeVisible();
    });

    test("shows who changed what", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/audit");

        // Telling a job apart from an operator is usually the question being
        // asked of this log.
        await expect(page.getByText("DepleteJob")).toBeVisible();
        await expect(page.getByText("disable")).toBeVisible();
    });

    test("lists the routes out of a node", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/outbounds");

        const routes = page.getByRole("list", { name: "Routes out" });
        const card = (tag: string) =>
            routes.getByRole("listitem").filter({
                has: page.getByRole("heading", { name: tag, exact: true }),
            });
        const value = (tag: string, term: string) =>
            card(tag).locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");

        // Where it sends traffic is read off the options the core stores rather
        // than a field of its own.
        await expect(value("upstream", "Address")).toHaveText("10.0.0.2");
        await expect(value("upstream", "Port")).toHaveText("1080");
        // A direct outbound decides an outcome on the node, so it has no address.
        await expect(value("out", "Address")).toHaveText("—");
    });

    test("lays the routes out as cards six across on a wide screen", async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await mockApi(page, {
            signedIn: true,
            maintenance: false,
            outbounds: Array.from({ length: 7 }, (_, index) => ({
                id: index + 1,
                type: "socks",
                tag: `hop-${index + 1}`,
                server: "10.0.0.2",
                server_port: 1080 + index,
            })),
        });

        await page.goto("/outbounds");

        const routes = page.getByRole("list", { name: "Routes out" });
        const cards = routes.getByRole("listitem");

        await expect(cards).toHaveCount(7);

        const boxes = await Promise.all(
            (await cards.all()).map(async (card) => (await card.boundingBox())!),
        );

        // The same grid as the listeners': six to a row, the seventh starting
        // the next one, and the one way to add another centred over them.
        expect(new Set(boxes.slice(0, 6).map((box) => box.y)).size).toBe(1);
        expect(boxes[6].x).toBe(boxes[0].x);

        const grid = (await routes.boundingBox())!;
        const add = (await page.getByRole("button", { name: "Add Outbound" }).boundingBox())!;

        expect(Math.abs(add.x + add.width / 2 - (grid.x + grid.width / 2))).toBeLessThan(1);
    });

    test("deletes a route out once asked on its card", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByLabel("Delete upstream").click();

        const question = page
            .getByRole("list", { name: "Routes out" })
            .getByRole("listitem")
            .filter({ hasText: "upstream" })
            .getByRole("alertdialog", { name: "Delete" });

        // What it costs a route rule is said before it is done.
        await expect(question).toContainText("nowhere to send");
        await question.getByRole("button", { name: "Yes" }).click();

        await expect(page.getByRole("heading", { name: "upstream" })).toBeHidden();
        expect(state.outbounds?.map((outbound) => outbound.tag)).toEqual(["out"]);
    });

    test("saves a runtime setting", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/general/settings?tab=subscription");

        const save = page
            .getByRole("form", { name: "Subscription", exact: true })
            .getByRole("button", { name: "Save", exact: true });

        // Nothing to save until something has changed.
        await expect(save).toBeDisabled();
        await page.getByLabel("Refresh interval (hours)").fill("24");
        await save.click();
        await expect(save).toBeDisabled();

        // Read back from the API rather than from the field, so this is the
        // write having landed rather than the field having been typed in.
        await page.reload();
        await expect(page.getByLabel("Refresh interval (hours)")).toHaveValue("24");
    });

    test("switches a subscription setting from its switch", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/general/settings?tab=subscription");

        const form = page.getByRole("form", { name: "Subscription", exact: true });
        const info = form.getByRole("switch", { name: "Show the remaining quota and expiry" });

        await expect(info).not.toBeChecked();
        await info.press("Space");
        await form.getByRole("button", { name: "Save", exact: true }).click();

        await expect.poll(() => state.settings?.subShowInfo).toBe("true");
        await expect(page.getByLabel("Current subscription URI")).toHaveValue(
            "https://sub.example.com/sub/",
        );
    });

    test("separates subscription content from editable service settings", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/general/settings?tab=subscription");

        const form = page.getByRole("form", { name: "Subscription", exact: true });
        const service = page.getByRole("form", { name: "Subscription service", exact: true });
        const boxOf = async (control: Locator) => (await control.boundingBox())!;

        await expect(service.getByLabel("Current subscription URI")).toHaveValue(
            "https://sub.example.com/sub/",
        );

        const uri = await boxOf(service.getByLabel("Current subscription URI"));
        const refresh = await boxOf(form.getByLabel("Refresh interval (hours)"));

        expect(uri.width).toBeGreaterThan(refresh.width);

        // ...how it is written for subscribers under them, a switch to a row...
        const encode = await boxOf(
            form.getByRole("switch", { name: "Base64-encode the subscription" }),
        );
        const info = await boxOf(
            form.getByRole("switch", { name: "Show the remaining quota and expiry" }),
        );

        expect(encode.y).toBeGreaterThan(refresh.y + refresh.height);
        expect(info.y).toBeGreaterThan(encode.y + encode.height);

        const port = service.getByLabel("Port", { exact: true });

        await expect(port).toHaveValue("8443");
        await expect(port).toBeEditable();
        expect((await boxOf(port)).y).toBeGreaterThan(info.y + info.height);

        // ...and the buttons along the foot, Save last. Maintenance is the
        // overview's.
        const restore = await boxOf(form.getByRole("button", { name: "Restore defaults" }));
        const save = await boxOf(form.getByRole("button", { name: "Save", exact: true }));

        expect(restore.y).toBeGreaterThan(info.y + info.height);
        expect(save.x).toBeGreaterThan(restore.x);
        expect(
            (await boxOf(service.getByRole("button", { name: "Save", exact: true }))).y,
        ).toBeGreaterThan((await boxOf(port)).y);
        await expect(page.getByRole("button", { name: /maintenance/i })).toHaveCount(0);
    });

    test("leads old settings and Basics addresses to their settings tabs", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/settings");

        await expect(page).toHaveURL(/\/general\/settings$/);
        await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

        // It is the page under General, which is where the section's own
        // address leads...
        await page.goto("/general");

        await expect(page).toHaveURL(/\/general\/settings$/);

        // ...and where the subscription's page was leads to its tab.
        await page.goto("/general/subscriptions");

        await expect(page).toHaveURL(/\/general\/settings\?tab=subscription$/);
        await expect(page.getByRole("tab", { name: "Subscription" })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(page.getByLabel("Refresh interval (hours)")).toBeVisible();

        // The former Basics page now opens the first of its two settings tabs.
        await page.goto("/basics");
        await expect(page).toHaveURL(/\/general\/settings\?tab=ntp$/);
        await expect(page.getByRole("tab", { name: "NTP", exact: true })).toHaveAttribute(
            "aria-selected",
            "true",
        );
    });

    test("lays the settings out in tabs, the open one kept in the address", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/general/settings");

        const tabs = page.getByRole("tablist", { name: "Settings" });

        await expect(tabs.getByRole("tab")).toHaveText([
            "Panel",
            "Subscription",
            "Two-factor authentication",
            "Telegram Bot",
            "Sing Box",
            "NTP",
            "HTTP Clients",
            "Experimental",
            "Logs",
        ]);
        await expect(tabs.getByRole("tab", { name: "Panel" })).toHaveAttribute(
            "aria-selected",
            "true",
        );

        await tabs.getByRole("tab", { name: "Telegram Bot" }).click();

        await expect(page).toHaveURL(/\/general\/settings\?tab=telegram$/);
        await expect(page.getByRole("form", { name: "Telegram Bot" })).toBeVisible();

        // So a reload opens on the same one.
        await page.reload();

        await expect(tabs.getByRole("tab", { name: "Telegram Bot" })).toHaveAttribute(
            "aria-selected",
            "true",
        );
    });

    test("scrolls the tabs on a phone rather than writing one name over the next", async ({
        page,
    }) => {
        await mockApi(page, { signedIn: true, maintenance: false });
        await page.setViewportSize({ width: 390, height: 844 });

        await page.goto("/general/settings");

        const tabs = page.getByRole("tablist", { name: "Settings" });

        // The row starts at its first tab rather than centred past it...
        await expect(tabs.getByRole("tab", { name: "Panel" })).toBeInViewport();

        // ...and every name keeps the room it needs, each after the last.
        const boxes = await tabs.getByRole("tab").evaluateAll((elements) =>
            elements.map((element) => ({
                left: element.getBoundingClientRect().left,
                right: element.getBoundingClientRect().right,
                fits: element.scrollWidth <= element.clientWidth,
            })),
        );

        expect(boxes.every(({ fits }) => fits)).toBe(true);
        boxes.slice(1).forEach(({ left }, index) => {
            expect(left).toBeGreaterThanOrEqual(boxes[index].right - 0.5);
        });

        // Opened on the last tab, the row brings that one into view.
        await page.goto("/general/settings?tab=logs");

        await expect(tabs.getByRole("tab", { name: "Logs" })).toBeInViewport();
    });

    test("shows editable panel settings and the session-secret warning", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/general/settings?tab=panel");

        const panel = page.getByRole("tabpanel", { name: "Panel", exact: true });

        await expect(panel.getByLabel("Port", { exact: true })).toHaveValue("8000");
        await expect(panel.getByLabel("Port", { exact: true })).toBeEditable();
        await expect(panel.getByLabel("Web path")).toHaveValue("/");
        await expect(panel.getByLabel("Session length (minutes)")).toHaveValue("0");
        await expect(panel.getByLabel("Traffic kept for (days)")).toHaveValue("30");
        await expect(panel.getByLabel("Global traffic reset")).toHaveValue("");
        // Without a secret of its own, every session ends at a restart.
        await expect(panel).toContainText("No session secret is configured");
        await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    });

    test("turns two-factor authentication on with a code from the app", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/general/settings?tab=two-factor");

        const form = page.getByRole("form", { name: "Two-factor authentication" });

        await expect(form).toContainText("off for operator");
        await form.getByRole("button", { name: "Set up" }).click();

        // Scanned from the code, or typed from the secret in the groups an app
        // shows it in.
        await expect(form.getByLabel("QR code for operator's authenticator app")).toBeVisible();
        await expect(form.getByLabel("Secret", { exact: true })).toHaveValue(
            "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP",
        );
        await expect(form.getByRole("button", { name: "Copy the secret" })).toBeVisible();

        // A code the app never showed is refused, and the setup waits for the
        // right one.
        await form.getByLabel("Code from your app").fill("000000");
        await form.getByRole("button", { name: "Turn on" }).click();
        await expect(form).toContainText("wrong two-factor code");
        expect(state.twoFactor).toBeFalsy();

        await form.getByLabel("Code from your app").fill("123 456");
        await form.getByRole("button", { name: "Turn on" }).click();

        await expect(form).toContainText("on for operator");
        expect(state.twoFactor).toBe(true);

        // And the operator's card says so.
        await page.goto("/admins");
        await expect(cardValue(page, "Operators", "operator", "Two-factor")).toHaveText("On");
    });

    test("turns two-factor authentication off with a code as well", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, twoFactor: true };

        await mockApi(page, state);

        await page.goto("/general/settings?tab=two-factor");

        const form = page.getByRole("form", { name: "Two-factor authentication" });

        await expect(form).toContainText("on for operator");
        await form.getByLabel("Code from your app").fill("123456");
        await form.getByRole("button", { name: "Turn off" }).click();

        await expect(form).toContainText("off for operator");
        expect(state.twoFactor).toBe(false);
    });

    test("saves the Telegram bot, and sends a test message through it", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/general/settings?tab=telegram");

        const form = page.getByRole("form", { name: "Telegram Bot" });
        const save = form.getByRole("button", { name: "Save", exact: true });
        const test = form.getByRole("button", { name: "Send a test message" });

        // Switched on with nowhere to send from or to, it is refused before it
        // is saved, and there is nothing yet to test.
        await expect(test).toBeDisabled();
        await form.getByRole("switch", { name: "Send notifications" }).press("Space");
        await expect(form).toContainText("Give the bot its token and at least one chat");
        await expect(save).toBeDisabled();

        await form.getByLabel("Bot token").fill("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0");
        await form.getByLabel("Chat IDs (comma separated)").fill("1111, -100222");
        await form.getByRole("switch", { name: "Operator sign-ins" }).press("Space");
        await save.click();

        await expect(save).toBeDisabled();
        expect(state.settings).toMatchObject({
            tgBotEnable: "true",
            tgBotToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0",
            tgBotChatIds: "1111,-100222",
            tgNotifySignIn: "false",
            tgNotifyDeplete: "true",
        });

        // The test goes out with the bot as it is saved.
        await test.click();

        await expect(form).toContainText("A test message was sent to every chat.");
        expect(state.telegramTests).toBe(1);
    });

    test("puts back one tab's defaults without another's", async ({ page }) => {
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            settings: {
                ...defaultSettings,
                subUpdates: "24",
                tgBotToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0",
                tgBotChatIds: "1111",
            },
        };

        await mockApi(page, state);

        await page.goto("/general/settings?tab=telegram");

        const form = page.getByRole("form", { name: "Telegram Bot" });

        await form.getByRole("button", { name: "Restore defaults" }).click();

        await expect(form.getByLabel("Bot token")).toHaveValue("");
        await expect(form.getByLabel("Chat IDs (comma separated)")).toHaveValue("");
        // The subscription's are the subscription tab's to put back.
        expect(state.settings?.subUpdates).toBe("24");
    });

    test("shows the configuration a node fetches, to copy or save", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: true });

        await page.goto("/general/settings?tab=sing-box");

        const panel = page.getByRole("tabpanel", { name: "Sing Box", exact: true });
        const document = panel.getByLabel("Configuration", { exact: true });

        await expect(document).toHaveAttribute("readonly", "");
        await expect(document).toHaveValue(/"tag": "upstream"/);
        // In maintenance the listeners are withheld, and the tab says so.
        await expect(document).toHaveValue(/"inbounds": \[\]/);
        await expect(panel).toContainText("Maintenance is on");

        await expect(panel.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            /\/api\/config\/download$/,
        );
        await expect(panel.getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
    });

    test("switches on the Clash API a node's agent reads traffic from", async ({ page }) => {
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            baseConfig: { log: { level: "info" }, dns: { servers: [] }, experimental: {} },
        };

        await mockApi(page, state);

        await page.goto("/general/settings?tab=experimental");

        const form = page.getByRole("form", { name: "Experimental" });
        // Each interface is a group of its own, so its Enabled is the one it
        // switches.
        const clashApi = form.getByRole("group", { name: "Clash API", exact: true });

        // Off, the tab says what that costs the panel; on, it has no need to.
        await expect(clashApi).toContainText("reads the traffic it reports from this API");
        await clashApi.getByRole("switch", { name: "Enabled" }).press("Space");
        await expect(clashApi.getByLabel("External controller")).toHaveValue("127.0.0.1:9090");
        await expect(clashApi).not.toContainText("reads the traffic it reports");
        // The other two stay as they were.
        await expect(
            form
                .getByRole("group", { name: "Cache file", exact: true })
                .getByRole("switch", { name: "Enabled" }),
        ).not.toBeChecked();
        // A field holding something keeps its label small in its top edge, clear of
        // the value, however many empty fields there are beside it in the group.
        await expect(clashApi.locator("label", { hasText: "External controller" })).toHaveCSS(
            "font-size",
            "12px",
        );
        await expect(clashApi.locator("label", { hasText: "Secret" })).toHaveCSS(
            "font-size",
            "16px",
        );
        // Typed as a list, commas and all.
        await clashApi
            .getByLabel("Allowed origins, comma separated")
            .pressSequentially("https://a.example, https://b.example");

        await form.getByRole("button", { name: "Save", exact: true }).click();

        await expect
            .poll(() => (state.baseConfig?.experimental as Record<string, unknown>)?.clash_api)
            .toEqual({
                external_controller: "127.0.0.1:9090",
                access_control_allow_origin: ["https://a.example", "https://b.example"],
            });
        // The rest of the document goes back as it came.
        expect(state.baseConfig?.log).toEqual({ level: "info" });
        expect(state.baseConfig?.dns).toEqual({ servers: [] });
    });

    test("sets how much the core logs, and writes it only when saved", async ({ page }) => {
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            baseConfig: { log: { level: "info" }, dns: { servers: [] }, experimental: {} },
        };

        await mockApi(page, state);

        await page.goto("/general/settings?tab=logs");

        const form = page.getByRole("form", { name: "Logs" });
        const save = form.getByRole("button", { name: "Save", exact: true });

        // The nodes' log rather than the panel's, and the tab says where that is.
        await expect(form).toContainText("The panel's own log is on the overview.");
        await expect(form.getByLabel("Level")).toHaveValue("info");
        await expect(save).toBeDisabled();

        await form.getByLabel("Level").selectOption("debug");
        await form.getByRole("switch", { name: "Timestamp" }).press("Space");

        // Nothing is written until it is saved.
        expect(state.baseConfig?.log).toEqual({ level: "info" });

        await save.click();

        await expect.poll(() => state.baseConfig?.log).toEqual({ level: "debug", timestamp: true });
        await expect(save).toBeDisabled();
        // The rest of the document goes back as it came.
        expect(state.baseConfig?.dns).toEqual({ servers: [] });
        expect(state.baseConfig?.experimental).toEqual({});
    });

    test("renames a subscriber while keeping their listeners and credentials", async ({ page }) => {
        // The API replaces the set with whatever an update sends, so a form that
        // opened without it would cut them off from every listener. This is the
        // regression that matters most on this page -- and the same goes for
        // their credentials, which the listing the row came from leaves out.
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/clients");
        await page.getByLabel("Edit alice").click();

        const dialog = page.getByRole("dialog");

        // The chosen listeners are read out with the field, as its chips are.
        await expect(dialog.getByRole("button", { name: /^Inbound tags/ })).toHaveAccessibleName(
            "Inbound tags edge",
        );
        await dialog.getByLabel("Name", { exact: true }).fill("alice-renamed");
        await dialog.getByLabel("Description").fill("changed something else");
        await page.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.clients?.[0]).toMatchObject({
            id: 1,
            name: "alice-renamed",
            desc: "changed something else",
            inbounds: [1],
            up: 1024 ** 3,
            down: 2 * 1024 ** 3,
            config: { vless: { uuid: "0f1e2d3c-4b5a-4968-8776-655443322110" } },
        });

        await page.reload();
        await page.getByLabel("Edit alice-renamed").click();

        await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("alice-renamed");
        await expect(
            page.getByRole("dialog").getByRole("button", { name: /^Inbound tags/ }),
        ).toHaveAccessibleName("Inbound tags edge");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

        await page.getByLabel("Connection links for alice-renamed").click();
        await expect(
            dialog.getByText("https://sub.example.com/sub/alice-renamed", { exact: true }),
        ).toBeVisible();
    });

    test("assigns a subscriber to a listener", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        await page.getByLabel("Edit alice").click();

        const dialog = page.getByRole("dialog");

        // Picked from the list under the field, which stays open for the next
        // and is put away on Escape without the dialog.
        await dialog.getByRole("button", { name: /^Inbound tags/ }).click();
        await page.getByRole("menuitemcheckbox", { name: "edge" }).click();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await page.getByRole("button", { name: "Save" }).click();

        await page.reload();
        await page.getByLabel("Edit alice").click();

        await expect(
            page.getByRole("dialog").getByRole("button", { name: /^Inbound tags/ }),
        ).toHaveAccessibleName("Inbound tags");
    });

    test("adds a subscriber from the Basics and Config tabs", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/clients");
        await page.getByRole("button", { name: "Add client" }).click();

        const dialog = page.getByRole("dialog", { name: "Add client" });

        // Links are the API's to build, once there is a subscriber to build them
        // for, so a new one has no tab for them.
        await expect(dialog.getByRole("tab")).toHaveText(["Basics", "Config"]);
        await expect(dialog.getByRole("tab", { name: "Basics" })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await dialog.getByLabel("Name").fill("bob");
        await dialog.getByLabel("Group").fill("friends");
        await dialog.getByLabel("Volume (GiB)").fill("5");

        // Repeating the quota asks for how often, starting at a day.
        await expect(dialog.getByLabel("Reset days")).toHaveCount(0);
        await dialog.getByRole("switch", { name: "Auto reset" }).press("Space");
        await expect(dialog.getByLabel("Reset days")).toHaveValue("1");
        await dialog.getByLabel("Reset days").fill("30");

        await dialog.getByRole("button", { name: "Every inbound" }).click();
        await expect(dialog.getByRole("button", { name: /^Inbound tags/ })).toHaveAccessibleName(
            "Inbound tags edge",
        );

        // Every credential is drawn as the dialog opens, as the reference draws
        // them, and one can still be given instead, for somebody moved here with
        // their client application already set up.
        await dialog.getByRole("tab", { name: "Config" }).click();
        await expect(
            dialog.getByRole("group", { name: "trojan" }).getByLabel("Password"),
        ).toHaveValue(SECRET);
        await dialog
            .getByRole("group", { name: "vless" })
            .getByLabel("UUID")
            .fill("9a8b7c6d-5e4f-4321-8abc-def012345678");

        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog).toBeHidden();

        const bob = state.clients?.find((c) => c.name === "bob");

        expect(bob).toMatchObject({
            group: "friends",
            volume: 5 * 1024 ** 3,
            autoReset: true,
            resetDays: 30,
            inbounds: [1],
            // What was typed, and what was drawn for every other protocol.
            config: {
                vless: { uuid: "9a8b7c6d-5e4f-4321-8abc-def012345678" },
                trojan: { password: expect.stringMatching(SECRET) },
            },
        });
        expect(Object.keys(bob?.config ?? {})).toHaveLength(14);
    });

    test("lists a saved subscriber's links on a tab of their own", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        await page.getByLabel("Edit alice").click();

        const dialog = page.getByRole("dialog");

        // Built by the API from the listeners they are given, which a subscriber
        // who has been saved has.
        await expect(dialog.getByRole("tab")).toHaveText(["Basics", "Config", "Links"]);
        await dialog.getByRole("tab", { name: "Links" }).click();
        await expect(dialog.getByText("vless://uuid@edge.example.com:443#alice")).toBeVisible();
    });

    test("brings a refused field back into view from another tab", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        await page.getByRole("button", { name: "Add client" }).click();

        const dialog = page.getByRole("dialog", { name: "Add client" });

        await dialog.getByRole("tab", { name: "Config" }).click();
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog.getByRole("tab", { name: "Basics" })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(dialog.getByLabel("Name")).toHaveAccessibleDescription("Enter a name.");
    });

    test("holds a subscriber's clock without a date of its own", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        await page.getByRole("button", { name: "Add client" }).click();

        const dialog = page.getByRole("dialog", { name: "Add client" });

        // Held until the first byte and not repeated, it runs for so many days
        // from then, so there is no date to set.
        await expect(dialog.getByLabel("Expiry")).toBeVisible();
        await dialog.getByRole("switch", { name: "Delay start" }).press("Space");
        await expect(dialog.getByLabel("Expiry")).toHaveCount(0);
        await expect(dialog.getByLabel("Reset days")).toHaveValue("1");

        // One who has spent anything has started their clock already.
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await page.getByLabel("Edit alice").click();
        await expect(
            page.getByRole("dialog").getByRole("switch", { name: "Delay start" }),
        ).toBeDisabled();
    });

    test("starts a subscriber's credential afresh only when asked to", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/clients");
        await page.getByLabel("Edit alice").click();

        const dialog = page.getByRole("dialog");
        const vless = dialog.getByRole("group", { name: "vless" });
        const uuid = vless.getByLabel("UUID");

        // Read from the subscriber on their own, since the row leaves them out.
        await dialog.getByRole("tab", { name: "Config" }).click();
        await expect(uuid).toHaveValue("0f1e2d3c-4b5a-4968-8776-655443322110");

        // Drawn afresh at once, and saved as it was shown; the name the API keeps
        // in step itself stays.
        await vless.getByRole("button", { name: "Reset vless" }).click();
        await expect(uuid).toHaveValue(UUID_V4);
        await expect(uuid).not.toHaveValue("0f1e2d3c-4b5a-4968-8776-655443322110");

        const drawn = await uuid.inputValue();

        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.clients?.[0].config).toEqual({ vless: { name: "alice", uuid: drawn } });
    });

    test("draws every credential afresh from Reset all", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/clients");
        await page.getByLabel("Edit alice").click();

        const dialog = page.getByRole("dialog");
        const trojan = dialog.getByRole("group", { name: "trojan" }).getByLabel("Password");

        // The protocols a subscriber holds nothing for yet are drawn along with
        // the ones they do, so every row has something once it is pressed.
        await dialog.getByRole("tab", { name: "Config" }).click();
        await expect(trojan).toHaveValue("");
        await dialog.getByRole("button", { name: "Reset all" }).click();
        await expect(trojan).toHaveValue(SECRET);
        await expect(
            dialog.getByRole("group", { name: "vless" }).getByLabel("UUID"),
        ).not.toHaveValue("0f1e2d3c-4b5a-4968-8776-655443322110");

        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(Object.keys(state.clients?.[0].config ?? {})).toHaveLength(14);
        expect(state.clients?.[0].config.vless).toMatchObject({
            name: "alice",
            uuid: expect.stringMatching(UUID_V4),
        });
    });

    test("narrows the subscribers by status", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");

        const table = page.getByRole("table", { name: "Subscribers" });

        await expect(table.getByRole("cell", { name: "alice", exact: true })).toBeVisible();

        // Filled in and then applied, the way the reference's filter is, and
        // narrowed by the API rather than by the panel, so this is a request
        // going out rather than rows being hidden.
        await page.getByRole("button", { name: "Filter subscribers" }).click();
        await page.getByLabel("Status").selectOption("false");
        await page.getByRole("button", { name: "Apply" }).click();

        await expect(table.getByRole("cell", { name: "alice", exact: true })).toBeHidden();
    });

    test("resets a subscriber's traffic without losing what they spent", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");

        // Kept with the subscriber's record rather than along their row, where
        // the reference keeps it too.
        await page.getByLabel("Edit alice").click();
        await page.getByRole("dialog").getByRole("button", { name: "Reset traffic" }).click();

        await expect(page.getByText("added to their lifetime total")).toBeVisible();
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        // The question goes once the reset is done, and only then is the one
        // Cancel left the edit dialog's.
        await expect(page.getByRole("alertdialog")).toBeHidden();
        await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

        // The period starts again at nothing.
        await expect(
            page.getByRole("table", { name: "Subscribers" }).getByText(/^0 B \//),
        ).toBeVisible();
    });

    test("resets every subscriber's traffic at once", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        await page.getByRole("button", { name: "Tools" }).click();
        await page.getByRole("menuitem", { name: "Reset all traffic" }).click();

        // Asked about first, since it hands everybody's quota back at once.
        await expect(page.getByRole("alertdialog")).toContainText("Every subscriber starts");
        await page.getByRole("button", { name: "Reset", exact: true }).click();

        await expect(
            page.getByRole("table", { name: "Subscribers" }).getByText(/^0 B \//),
        ).toBeVisible();
    });

    test("switches a subscriber off from the table without dropping the rest of them", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/clients");

        const enabled = page.getByRole("switch", { name: "Enable alice" });

        await expect(enabled).toBeChecked();
        // Pressed from the keyboard: the drawn switch lies over the input it
        // stands for, which is what a pointer would land on instead.
        await enabled.press("Space");

        await expect(enabled).not.toBeChecked();
        // Written back whole, because the API replaces what it is sent: the
        // listeners they connect through went back with them.
        expect(state.clients?.[0]).toMatchObject({ enable: false, inbounds: [1] });
    });

    test("asks before deleting a subscriber, over their row", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/clients");

        const remove = page.getByLabel("Delete alice");

        await remove.click();

        const question = page.getByRole("alertdialog", { name: "Delete" });

        // What it costs is said before it is done, and the way out is where it
        // opens.
        await expect(question).toContainText("traffic history");
        await expect(question.getByRole("button", { name: "No" })).toBeFocused();
        await question.getByRole("button", { name: "No" }).click();

        await expect(question).toBeHidden();
        expect(state.clients).toHaveLength(1);

        await remove.click();
        await page
            .getByRole("alertdialog", { name: "Delete" })
            .getByRole("button", { name: "Yes" })
            .click();

        await expect(
            page
                .getByRole("table", { name: "Subscribers" })
                .getByRole("cell", { name: "alice", exact: true }),
        ).toBeHidden();
    });

    test("lays the subscribers out in the reference's columns", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");

        await expect(
            page.getByRole("table", { name: "Subscribers" }).getByRole("columnheader"),
        ).toHaveText([
            "Name",
            "Enable",
            "Description",
            "Group",
            "Inbounds",
            "Action",
            "Volume",
            "Expiry",
            "Online",
            "Created",
            "Last online",
        ]);
    });

    test("pages through the subscribers ten at a time", async ({ page }) => {
        await mockApi(page, {
            signedIn: true,
            maintenance: false,
            clients: Array.from({ length: 12 }, (_, index) => ({
                ...client,
                id: index + 1,
                name: `user-${String(index + 1).padStart(2, "0")}`,
            })),
        });

        await page.goto("/clients");

        const table = page.getByRole("table", { name: "Subscribers" });

        // "10 subscribers" and "10 of 12" are different situations to be looking
        // at, so the count is said once there is more than a page.
        await expect(page.getByText("1-10 of 12")).toBeVisible();
        await expect(table.getByRole("cell", { name: "user-11", exact: true })).toBeHidden();

        await page.getByRole("button", { name: "Next page" }).click();

        await expect(page.getByText("11-12 of 12")).toBeVisible();
        await expect(table.getByRole("cell", { name: "user-11", exact: true })).toBeVisible();
    });

    test("adds a route out", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog", { name: "Add Outbound" });

        await dialog.getByLabel("Type").selectOption("socks");
        await dialog.getByLabel("Tag").fill("hop");
        await dialog.getByLabel("Server address").fill("10.9.0.1");
        await dialog.getByLabel("Server port").fill("1081");
        await dialog.getByLabel("Username").fill("socks-user");
        await dialog.getByLabel("Password").fill("socks-secret");
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await dialog.getByRole("button", { name: "Save" }).click();

        const routes = page.getByRole("list", { name: "Routes out" });

        await expect(routes.getByRole("heading", { name: "hop", exact: true })).toBeVisible();
        await expect(routes.getByText("10.9.0.1")).toBeVisible();
        expect(state.outbounds?.find((outbound) => outbound.tag === "hop")).toEqual({
            id: 3,
            type: "socks",
            tag: "hop",
            server: "10.9.0.1",
            server_port: 1081,
            username: "socks-user",
            password: "socks-secret",
        });
    });

    test("adds an HTTP route with proxy credentials", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };
        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog", { name: "Add Outbound" });
        await dialog.getByLabel("Type").selectOption("http");
        await dialog.getByLabel("Tag").fill("http-hop");
        await dialog.getByLabel("Server address").fill("proxy.example.com");
        await dialog.getByLabel("Server port").fill("8080");
        await dialog.getByLabel("Username").fill("http-user");
        await dialog.getByLabel("Password").fill("http-secret");
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.find((outbound) => outbound.tag === "http-hop")).toEqual({
            id: 3,
            type: "http",
            tag: "http-hop",
            server: "proxy.example.com",
            server_port: 8080,
            username: "http-user",
            password: "http-secret",
        });
    });

    test("adds a Shadowsocks route with its credentials and encryption method", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };
        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog", { name: "Add Outbound" });
        await dialog.getByLabel("Type").selectOption("shadowsocks");
        await expect(dialog.getByLabel("Tag")).toBeVisible();
        await expect(dialog.getByLabel("Username")).toHaveCount(0);
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await dialog.getByLabel("Tag").fill("ss-upstream");
        await dialog.getByLabel("Server address").fill("ss.example.com");
        await dialog.getByLabel("Server port").fill("8388");

        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByText("Choose an encryption method.")).toBeVisible();

        await dialog.getByLabel("Encryption method").selectOption("aes-256-gcm");
        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByText("Enter a password.")).toBeVisible();

        await dialog.getByLabel("Password").fill("correct-horse-battery-staple");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.find((outbound) => outbound.tag === "ss-upstream")).toEqual({
            id: 3,
            type: "shadowsocks",
            tag: "ss-upstream",
            server: "ss.example.com",
            server_port: 8388,
            method: "aes-256-gcm",
            password: "correct-horse-battery-staple",
        });
    });

    test("adds VLESS with Reality fields in the TLS object", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };
        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();
        const dialog = page.getByRole("dialog", { name: "Add Outbound" });

        await dialog.getByLabel("Type").selectOption("vless");
        await dialog.getByLabel("Tag").fill("reality-upstream");
        await dialog.getByLabel("Server address").fill("example.com");
        await dialog.getByLabel("Server port").fill("443");
        await dialog.getByLabel("UUID").fill("bf000d23-0752-40b4-affe-68f7707a9661");
        await dialog.getByRole("switch", { name: "Enable TLS" }).press("Space");
        await dialog.getByLabel("TLS server name").fill("www.example.com");
        await dialog.getByRole("switch", { name: "Reality" }).press("Space");
        await dialog.getByLabel("Reality public key").fill("public-key");
        await dialog.getByLabel("Reality short ID").fill("0123456789abcdef");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.find((outbound) => outbound.tag === "reality-upstream")).toEqual({
            id: 3,
            type: "vless",
            tag: "reality-upstream",
            server: "example.com",
            server_port: 443,
            uuid: "bf000d23-0752-40b4-affe-68f7707a9661",
            tls: {
                enabled: true,
                server_name: "www.example.com",
                reality: { enabled: true, public_key: "public-key", short_id: "0123456789abcdef" },
            },
        });
    });

    test("adds a selector with an outbound tag list", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };
        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();
        const dialog = page.getByRole("dialog", { name: "Add Outbound" });
        await dialog.getByLabel("Type").selectOption("selector");
        await dialog.getByLabel("Tag", { exact: true }).fill("choose");
        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByText("Enter at least one outbound tag.")).toBeVisible();
        await dialog.getByLabel("Outbound tags (comma separated)").fill("out,upstream");
        await dialog.getByLabel("Default outbound tag").fill("upstream");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.find((outbound) => outbound.tag === "choose")).toEqual({
            id: 3,
            type: "selector",
            tag: "choose",
            outbounds: ["out", "upstream"],
            default: "upstream",
        });
    });

    test("lays out the route out dialog as the reference does", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog");
        const dial = dialog.getByRole("region", { name: "Dial" });

        // Before a type is chosen it looks as the reference's first route out
        // does: the type and the tag, and how it dials. The fields stand alone,
        // without the reference's second tab to read a share link into them.
        await expect(dialog.getByLabel("Type")).toBeVisible();
        await expect(dialog.getByRole("tab")).toHaveCount(0);
        await expect(dial).toBeVisible();
        await expect(dialog.getByLabel("Server address")).toHaveCount(0);
        await expect(dialog.getByLabel("Options")).toHaveCount(0);

        // A type that sends to a server says where. New routes do not expose a
        // raw options document.
        await dialog.getByLabel("Type").selectOption("socks");
        await expect(dialog.getByLabel("Server address")).toBeVisible();
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await expect(
            dialog.getByRole("link", { name: "socks route out documentation" }),
        ).toHaveAttribute("href", "https://sing-box.sagernet.org/configuration/outbound/socks/");

        // Three fields to a row, as the reference sets them, the blocks running
        // the width of the row.
        await settled(dialog);

        const type = (await dialog.getByLabel("Type").boundingBox())!;
        const server = (await dialog.getByLabel("Server address").boundingBox())!;

        expect(Math.round(type.width)).toBe(Math.round(server.width));
        expect(Math.round(type.width * 3 + 16)).toBe(Math.round((await dial.boundingBox())!.width));

        // Another type starts afresh, keeping only what it shares: direct dials
        // but sends to no server, and a selector does neither.
        await dialog.getByLabel("Server address").fill("10.9.0.1");
        await dialog.getByLabel("Type").selectOption("direct");
        await expect(dialog.getByLabel("Server address")).toHaveCount(0);
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await expect(dial).toBeVisible();
        await dialog.getByLabel("Type").selectOption("selector");
        await expect(dial).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "selector" })).toBeVisible();
        await expect(dialog.getByLabel("Outbound tags (comma separated)")).toBeVisible();
        await dialog.getByLabel("Type").selectOption("http");
        await expect(dialog.getByLabel("Server address")).toHaveValue("");
    });

    test("switches dial options on in groups, and writes them with the route out", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Type").selectOption("direct");
        await dialog.getByLabel("Tag").fill("local");

        await dialog.getByRole("button", { name: "Dial options" }).click();
        await page.getByRole("menuitemcheckbox", { name: "Detour" }).click();
        // The menu stays open for the next, and Escape puts away the menu alone.
        await page.getByRole("menuitemcheckbox", { name: "Connection timeout" }).click();
        await page.getByRole("menuitemcheckbox", { name: "TCP options" }).click();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden();
        await expect(dialog).toBeVisible();

        // A detour starts at the first other route out.
        await expect(dialog.getByLabel("Forward to outbound")).toHaveValue("out");
        await dialog.getByLabel("Forward to outbound").selectOption("upstream");
        await dialog.getByLabel("Connection timeout (seconds)").fill("10");
        await dialog.getByRole("switch", { name: "TCP Fast Open" }).press("Space");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.find((outbound) => outbound.tag === "local")).toEqual({
            id: 3,
            type: "direct",
            tag: "local",
            detour: "upstream",
            connect_timeout: "10s",
            tcp_fast_open: true,
            tcp_multi_path: false,
        });
    });

    test("renames and amends a route out without dropping the rest of it", async ({ page }) => {
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            outbounds: [
                { id: 1, type: "direct", tag: "out" },
                {
                    id: 2,
                    type: "socks",
                    tag: "upstream",
                    server: "10.0.0.2",
                    server_port: 1080,
                    username: "alice",
                    custom_option: { value: "preserve" },
                },
            ],
        };

        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByLabel("Edit upstream").click();

        const dialog = page.getByRole("dialog", { name: "Edit Outbound" });
        const tag = dialog.getByLabel("Tag", { exact: true });

        await expect(tag).toBeEnabled();
        await expect(tag).toHaveValue("upstream");
        await tag.fill("upstream-renamed");
        await expect(dialog.getByLabel("Username")).toHaveValue("alice");
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await expect(dialog.getByLabel("Server port")).toHaveValue("1080");
        await dialog.getByLabel("Server port").fill("1081");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        await expect(
            page.getByRole("heading", { name: "upstream-renamed", exact: true }),
        ).toBeVisible();
        expect(state.outbounds?.[1]).toEqual({
            id: 2,
            type: "socks",
            tag: "upstream-renamed",
            server: "10.0.0.2",
            server_port: 1081,
            username: "alice",
            custom_option: { value: "preserve" },
        });
    });

    test("checks displayed fields when editing", async ({ page }) => {
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            outbounds: [
                { id: 1, type: "direct", tag: "out" },
                { id: 2, type: "socks", tag: "upstream", server: "10.0.0.2" },
            ],
        };
        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByLabel("Edit upstream").click();

        const dialog = page.getByRole("dialog", { name: "Edit Outbound" });

        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByLabel("Server port")).toHaveAccessibleDescription(
            "Enter a server port from 1 to 65535.",
        );
        await dialog.getByLabel("Server port").fill("1080");
        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog).toBeHidden();
        expect(state.outbounds?.[1]).toMatchObject({ server: "10.0.0.2", server_port: 1080 });
    });

    test("refuses to remove the last outbound", async ({ page }) => {
        await mockApi(page, {
            signedIn: true,
            maintenance: false,
            outbounds: [{ id: 1, type: "direct", tag: "out" }],
        });

        await page.goto("/outbounds");
        await page.getByLabel("Delete out").click();

        // Said before the attempt rather than as an error afterwards, and the
        // only answer left is the way out.
        const question = page.getByRole("alertdialog", { name: "Delete" });

        await expect(question).toContainText("This is the only outbound");
        await expect(question.getByRole("button", { name: "Yes" })).toBeDisabled();
    });

    test("adds a block route, which is its type and tag alone", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog");

        // Chosen over another type, it keeps nothing of it, as it has nowhere
        // to keep it.
        await dialog.getByLabel("Type").selectOption("socks");
        await dialog.getByLabel("Server address").fill("10.9.0.1");
        await dialog.getByLabel("Type").selectOption("block");
        await dialog.getByLabel("Tag").fill("blocked");

        // Nothing past the type and the tag, and what it does is said rather
        // than left to be guessed from a dialog with nothing else in it.
        await expect(dialog.getByLabel("Server address")).toHaveCount(0);
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "Dial" })).toHaveCount(0);
        await expect(dialog.getByText("Every connection sent here is refused")).toBeVisible();
        await expect(
            dialog.getByRole("link", { name: "block route out documentation" }),
        ).toHaveAttribute("href", "https://sing-box.sagernet.org/configuration/outbound/block/");

        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.find((outbound) => outbound.tag === "blocked")).toEqual({
            id: 3,
            type: "block",
            tag: "blocked",
        });

        // It sends traffic nowhere, so its card has nowhere to show.
        const card = page
            .getByRole("list", { name: "Routes out" })
            .getByRole("listitem")
            .filter({ has: page.getByRole("heading", { name: "blocked", exact: true }) });

        await expect(card).toContainText("block");
        await expect(
            card.locator("dt", { hasText: "Address" }).locator("xpath=following-sibling::dd[1]"),
        ).toHaveText("—");
    });

    test("saves a block route written elsewhere as its type and tag alone", async ({ page }) => {
        // Written before the API refused options on one, or by something other
        // than the panel: the core refuses the configuration it is in, and the
        // dialog has no field to take the option out with.
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            outbounds: [
                { id: 1, type: "direct", tag: "out" },
                { id: 2, type: "block", tag: "blocked", server: "10.0.0.2" },
            ],
        };

        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByLabel("Edit blocked").click();

        const dialog = page.getByRole("dialog");

        // A type the panel offers, rather than one it has not heard of.
        await expect(dialog.getByLabel("Type")).toHaveValue("block");
        await expect(dialog.getByRole("option", { name: /not one this panel knows/ })).toHaveCount(
            0,
        );
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.[1]).toEqual({ id: 2, type: "block", tag: "blocked" });
    });

    test("leaves a block route out of what a route out dials through", async ({ page }) => {
        await mockApi(page, {
            signedIn: true,
            maintenance: false,
            outbounds: [
                { id: 1, type: "block", tag: "blocked" },
                { id: 2, type: "direct", tag: "out" },
                { id: 3, type: "wireguard", tag: "wg0", address: ["10.9.0.2/32"] },
            ],
        });

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Type").selectOption("direct");
        await dialog.getByRole("button", { name: "Dial options" }).click();
        await page.getByRole("menuitemcheckbox", { name: "Detour" }).click();
        await page.keyboard.press("Escape");

        // It refuses whatever is dialled through it, so it is not offered, and a
        // detour starts at the first route out past it rather than at it. A
        // WireGuard tunnel is dialled through as any other route out is.
        const detour = dialog.getByLabel("Forward to outbound");

        await expect(detour).toHaveValue("out");
        await expect(detour.getByRole("option")).toHaveText(["out", "wg0"]);
    });

    test("offers WireGuard by name while excluding removed outbound types", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const types = page.getByRole("dialog", { name: "Add Outbound" }).getByLabel("Type");
        await expect(types.locator('option[value="wireguard"]')).toHaveText("WireGuard");
        await expect(types.locator('option[value="dns"]')).toHaveCount(0);
        await expect(types.locator('option[value="tailcat"]')).toHaveCount(0);
    });

    test("adds a WireGuard route with the fields sing-box uses for an endpoint", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };
        await mockApi(page, state);

        await page.goto("/outbounds");
        await page.getByRole("button", { name: "Add Outbound" }).click();

        const dialog = page.getByRole("dialog", { name: "Add Outbound" });
        await dialog.getByLabel("Type").selectOption("wireguard");
        await dialog.getByLabel("Tag").fill("wg0");

        await expect(dialog.getByLabel("Type")).toHaveValue("wireguard");
        await expect(dialog.getByLabel("Options")).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "WireGuard" })).toBeVisible();
        await expect(dialog.getByRole("link", { name: "WireGuard documentation" })).toHaveAttribute(
            "href",
            "https://sing-box.sagernet.org/configuration/endpoint/wireguard/",
        );

        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByLabel("Server address")).toHaveAccessibleDescription(
            "Enter a server address.",
        );

        await dialog.getByLabel("Server address").fill("vpn.example.com");
        await dialog.getByLabel("Server port").fill("51820");
        await dialog.getByRole("button", { name: "Generate a WireGuard key pair" }).click();
        await expect(dialog.getByLabel("Private key")).toHaveValue(
            "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        );
        await dialog.getByLabel("Local IPs (comma separated)").fill("10.9.0.2/32");
        await dialog
            .getByLabel("Peer public key")
            .fill("AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.outbounds?.find((outbound) => outbound.tag === "wg0")).toMatchObject({
            type: "wireguard",
            tag: "wg0",
            private_key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            address: ["10.9.0.2/32"],
            peers: [
                {
                    address: "vpn.example.com",
                    port: 51820,
                    public_key: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
                    allowed_ips: ["0.0.0.0/0", "::/0"],
                },
            ],
        });
    });

    test("amends and removes a WireGuard route as any other route out", async ({ page }) => {
        const privateKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
        const peerKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            outbounds: [
                { id: 1, type: "direct", tag: "out" },
                {
                    id: 2,
                    type: "wireguard",
                    tag: "wg0",
                    address: ["10.9.0.2/32"],
                    private_key: privateKey,
                    peers: [
                        {
                            address: "vpn.example.com",
                            port: 51820,
                            public_key: peerKey,
                            allowed_ips: ["0.0.0.0/0"],
                            reserved: [1, 2, 3],
                        },
                    ],
                },
            ],
        };

        await mockApi(page, state);

        await page.goto("/outbounds");

        const routes = page.getByRole("list", { name: "Routes out" });

        await page.getByLabel("Edit wg0").click();

        const dialog = page.getByRole("dialog", { name: "Edit Outbound" });

        // Its fields read off its peer, the far end of the tunnel.
        await expect(dialog.getByLabel("Type")).toHaveValue("wireguard");
        await expect(dialog.getByLabel("Server address")).toHaveValue("vpn.example.com");
        await expect(dialog.getByLabel("Peer public key")).toHaveValue(peerKey);
        await expect(dialog.getByLabel("Options")).toHaveCount(0);

        // Worked out by the API from the private key there is.
        await dialog.getByRole("button", { name: "Work out the public key" }).click();
        await expect(dialog.getByLabel("Public key", { exact: true })).toHaveValue(
            `public-of-${privateKey}`,
        );

        await dialog.getByLabel("Server port").fill("51821");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();

        // Written back whole, with what no field shows kept as it was.
        expect(state.outbounds?.[1]).toEqual({
            id: 2,
            type: "wireguard",
            tag: "wg0",
            address: ["10.9.0.2/32"],
            private_key: privateKey,
            peers: [
                {
                    address: "vpn.example.com",
                    port: 51821,
                    public_key: peerKey,
                    allowed_ips: ["0.0.0.0/0"],
                    reserved: [1, 2, 3],
                },
            ],
        });

        // And taken away as any other route out is.
        await page.getByLabel("Delete wg0").click();
        await page
            .getByRole("alertdialog", { name: "Delete" })
            .getByRole("button", { name: "Yes" })
            .click();

        await expect(routes.getByRole("heading", { name: "wg0", exact: true })).toHaveCount(0);
        expect(state.outbounds?.map((outbound) => outbound.tag)).toEqual(["out"]);
    });

    // A node's DNS is one section of the base document, so these hand the page a
    // document with some in it and read what Save wrote back out of the same one.
    const dnsConfig = () => ({
        log: { level: "info" },
        dns: {
            servers: [
                { type: "udp", tag: "google", server: "8.8.8.8", server_port: 53 },
                {
                    type: "tls",
                    tag: "cloudflare-dot",
                    server: "1.1.1.1",
                    server_port: 853,
                    tls: { enabled: true },
                },
                { type: "local", tag: "local" },
            ],
            rules: [
                { domain_suffix: [".cn"], action: "route", server: "local" },
                {
                    type: "logical",
                    mode: "and",
                    rules: [{ domain: ["a.com"] }, { port: [443] }],
                    action: "route",
                    server: "google",
                    invert: true,
                },
            ],
            final: "google",
            strategy: "prefer_ipv4",
        },
    });

    interface DnsDocument {
        servers: { tag: string }[];
        rules: { server?: string }[];
        [option: string]: unknown;
    }

    const dnsIn = (state: ApiState) => state.baseConfig?.dns as DnsDocument;

    const namedCard = (page: Page, list: string, title: string) =>
        page
            .getByRole("list", { name: list })
            .getByRole("listitem")
            .filter({ has: page.getByRole("heading", { name: title, exact: true }) });

    const cardValue = (page: Page, list: string, title: string, term: string) =>
        namedCard(page, list, title)
            .locator("dt", { hasText: term })
            .locator("xpath=following-sibling::dd[1]");

    test("shows a node's DNS servers and rules as cards", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false, baseConfig: dnsConfig() });

        await page.goto("/dns");

        await expect(cardValue(page, "DNS servers", "google", "Server")).toHaveText("8.8.8.8");
        await expect(cardValue(page, "DNS servers", "cloudflare-dot", "TLS")).toHaveText("Enabled");
        // Asked on the node itself, so there is nowhere it is asked at.
        await expect(cardValue(page, "DNS servers", "local", "Port")).toHaveText("—");

        // A rule is known by where it stands in the order, and a logical one by
        // how many rules it combines.
        await expect(namedCard(page, "DNS rules", "2")).toContainText("Logical (and)");
        await expect(cardValue(page, "DNS rules", "2", "Rules")).toHaveText("2");
        await expect(cardValue(page, "DNS rules", "2", "Invert")).toHaveText("Yes");

        await expect(page.getByLabel("Final")).toHaveValue("google");
        await expect(page.getByLabel("Domain strategy")).toHaveValue("prefer_ipv4");
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    });

    test("lays the DNS settings out along one row on a wide screen", async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await mockApi(page, { signedIn: true, maintenance: false, baseConfig: dnsConfig() });

        await page.goto("/dns");

        const final = (await page.getByLabel("Final").boundingBox())!;
        const middle = (box: { y: number; height: number }) => box.y + box.height / 2;

        // The lists and the fields share a line, the first two boxes beside it,
        // and the third box is left for the next one, as in the reference.
        for (const label of ["Domain strategy", "Client subnet", "Cache capacity"]) {
            expect((await page.getByLabel(label).boundingBox())!.y).toBe(final.y);
        }

        expect(middle((await page.getByLabel("Disable expire").boundingBox())!)).toBe(
            middle(final),
        );
        expect(middle((await page.getByLabel("Reverse mapping").boundingBox())!)).toBeGreaterThan(
            final.y + final.height,
        );
    });

    test("adds a DNS server, and writes it only when saved", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");
        await page.getByRole("button", { name: "Add DNS server" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Type").selectOption("https");
        await dialog.getByLabel("Tag").fill("quad9");
        await dialog.getByLabel("Address").fill("9.9.9.9");
        await dialog.getByLabel("Path").fill("/dns-query");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(cardValue(page, "DNS servers", "quad9", "Server")).toHaveText("9.9.9.9");
        // On the page, and not yet in the document.
        expect(dnsIn(state).servers).toHaveLength(3);

        const save = page.getByRole("button", { name: "Save", exact: true });

        await save.click();
        await expect(save).toBeDisabled();

        expect(dnsIn(state).servers[3]).toEqual({
            type: "https",
            tag: "quad9",
            server: "9.9.9.9",
            path: "/dns-query",
        });
        // The rest of the document goes back as it came.
        expect(state.baseConfig?.log).toEqual({ level: "info" });
    });

    test("lays out the DNS server dialog as the reference does", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");
        await page.getByRole("button", { name: "Add DNS server" }).click();

        const dialog = page.getByRole("dialog");
        const dial = dialog.getByRole("region", { name: "Dial" });

        // Nothing chosen to start with, and nothing asked beyond the type and
        // the tag until something is.
        await expect(dialog.getByLabel("Type")).toHaveValue("");
        await expect(dialog.getByLabel("Address")).toHaveCount(0);
        await expect(
            dialog.getByRole("link", { name: "DNS server documentation" }),
        ).toHaveAttribute("href", "https://sing-box.sagernet.org/configuration/dns/server/");

        // Answered on the node: dialled out, with a switch of its own under the
        // block.
        await dialog.getByLabel("Type").selectOption("local");
        await expect(dial).toBeVisible();
        await expect(dialog.getByRole("switch", { name: "Prefer Go" })).toBeVisible();
        await expect(dialog.getByLabel("Address")).toHaveCount(0);

        // Three fields to a row, set in from the edges of the dialog as the
        // reference's are, and the blocks running the width of the row.
        await settled(dialog);

        const type = (await dialog.getByLabel("Type").boundingBox())!;
        const tag = (await dialog.getByLabel("Tag").boundingBox())!;

        expect(Math.round(type.width)).toBe(Math.round(tag.width));
        expect(Math.round(type.width * 3 + 16)).toBe(Math.round((await dial.boundingBox())!.width));

        // Asked over TLS at an address, with what it is asked with in a block
        // named for the type.
        await dialog.getByLabel("Type").selectOption("tls");
        await expect(dialog.getByLabel("Address")).toBeVisible();
        await expect(dialog.getByLabel("Path")).toHaveCount(0);
        await expect(
            dialog.getByRole("region", { name: "tls", exact: true }).getByLabel("Options"),
        ).toBeVisible();

        // A range handed out on the node dials nowhere, and another type starts
        // afresh.
        await dialog.getByLabel("Address").fill("1.1.1.1");
        await dialog.getByLabel("Type").selectOption("fakeip");
        await expect(dial).toHaveCount(0);
        await expect(dialog.getByLabel("Address")).toHaveCount(0);
        await dialog.getByLabel("Tag").fill("fake");
        await dialog.getByLabel("IPv4 range").fill("198.18.0.0/15");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => dnsIn(state).servers[3])
            .toEqual({ type: "fakeip", tag: "fake", inet4_range: "198.18.0.0/15" });
    });

    test("adds a hosts server with names it answers for itself", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");
        await page.getByRole("button", { name: "Add DNS server" }).click();

        const dialog = page.getByRole("dialog");
        const predefined = dialog.getByRole("region", { name: "Predefined" });

        await dialog.getByLabel("Type").selectOption("hosts");
        await dialog.getByLabel("Tag").fill("lan");
        await dialog.getByLabel("Path (comma separated)").fill("/etc/hosts, /etc/hosts.lan");
        // The block of fields stands where the reference's does, and there is
        // no document to type out besides.
        await expect(dialog.getByLabel("Options")).toHaveCount(0);

        // A row to a name, added from the head of the block and taken away from
        // its own end.
        await predefined.getByRole("button", { name: "Add a predefined host" }).click();
        await predefined.getByRole("button", { name: "Add a predefined host" }).click();
        await predefined.getByLabel("Domain").first().fill("router.lan");
        await predefined.getByLabel("Addresses").first().fill("192.168.1.1, fd00::1");
        await predefined.getByLabel("Domain").nth(1).fill("nas.lan");
        await predefined.getByRole("button", { name: "Delete nas.lan" }).click();
        await expect(predefined.getByLabel("Domain")).toHaveCount(1);
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => dnsIn(state).servers[3])
            .toEqual({
                type: "hosts",
                tag: "lan",
                path: ["/etc/hosts", "/etc/hosts.lan"],
                predefined: { "router.lan": ["192.168.1.1", "fd00::1"] },
            });
    });

    test("refuses a second DNS server under a tag already taken", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false, baseConfig: dnsConfig() });

        await page.goto("/dns");
        await page.getByRole("button", { name: "Add DNS server" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Type").selectOption("udp");
        await dialog.getByLabel("Tag").fill("google");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog.getByText("Another server has this tag.")).toBeVisible();
    });

    test("deletes a DNS server, and says which rule it leaves with nowhere to go", async ({
        page,
    }) => {
        await mockApi(page, { signedIn: true, maintenance: false, baseConfig: dnsConfig() });

        await page.goto("/dns");
        await page.getByRole("button", { name: "Delete local" }).click();

        const question = namedCard(page, "DNS servers", "local").getByRole("alertdialog", {
            name: "Delete",
        });

        await expect(question).toContainText("nowhere to send them");
        await question.getByRole("button", { name: "Yes" }).click();

        await expect(namedCard(page, "DNS servers", "local")).toBeHidden();
        await expect(cardValue(page, "DNS rules", "1", "Server")).toHaveText("local missing");
    });

    test("reorders the DNS rules by dragging one onto another", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");

        const rules = page.getByRole("list", { name: "DNS rules" }).getByRole("listitem");

        await rules.nth(1).dragTo(rules.nth(0));

        await expect(cardValue(page, "DNS rules", "1", "Server")).toHaveText("google");
        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect
            .poll(() => dnsIn(state).rules.map((rule) => rule.server))
            .toEqual(["google", "local"]);
    });

    test("edits a DNS rule without changing its place", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");
        await page.getByRole("button", { name: "Edit rule 2" }).click();

        const dialog = page.getByRole("dialog");

        await expect(dialog.getByLabel("Position")).toHaveCount(0);
        await dialog.getByLabel("Mode").selectOption("or");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(cardValue(page, "DNS rules", "1", "Server")).toHaveText("local");
        await expect(cardValue(page, "DNS rules", "2", "Server")).toHaveText("google");
        // Everything the dialog does not ask about is carried through untouched.
        await expect(cardValue(page, "DNS rules", "2", "Rules")).toHaveText("2");
        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect
            .poll(() => dnsIn(state).rules.map((rule) => rule.server))
            .toEqual(["local", "google"]);
        expect(dnsIn(state).rules[1]).toMatchObject({ mode: "or", server: "google" });
    });

    test("asks for a server only of a DNS rule that routes", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");
        await page.getByRole("button", { name: "Add DNS rule" }).click();

        const dialog = page.getByRole("dialog");

        // A new rule routes to the first server and is appended after existing rules.
        await expect(dialog.getByLabel("Server")).toHaveValue("google");
        await expect(dialog.getByLabel("Position")).toHaveCount(0);

        // One that rejects has no block to route with, and one of its own.
        await dialog.getByLabel("Action").selectOption("reject");
        await expect(dialog.getByRole("region", { name: "Route", exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "Reject", exact: true })).toBeVisible();

        // What it matches is switched on in the reference's groups, and a DNS
        // rule's entries are typed a comma apart.
        await dialog.getByRole("button", { name: "Rule options" }).click();
        await page.getByRole("menuitemcheckbox", { name: "Domain/IP" }).click();
        await page.keyboard.press("Escape");
        await dialog.getByLabel("Domain/IP").selectOption("domain_suffix");
        await dialog.getByLabel("Domain suffixes").fill(".ads.example, .track.example");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(cardValue(page, "DNS rules", "3", "Action")).toHaveText("reject");
        await expect(cardValue(page, "DNS rules", "3", "Server")).toHaveText("—");
        await expect(cardValue(page, "DNS rules", "3", "Rules")).toHaveText("1");

        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => dnsIn(state).rules[2])
            .toEqual({ domain_suffix: [".ads.example", ".track.example"], action: "reject" });
    });

    test("lays out the DNS rule dialog as the reference does", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");
        await page.getByRole("button", { name: "Add DNS rule" }).click();

        const dialog = page.getByRole("dialog");

        // A simple rule, what it matches, what it does, and the block the action
        // takes.
        await expect(dialog.getByRole("switch", { name: "Logical" })).not.toBeChecked();
        await expect(dialog.getByRole("region", { name: "Conditions" })).toHaveCount(1);
        await expect(dialog.getByRole("region", { name: "Route", exact: true })).toBeVisible();
        await expect(dialog.getByRole("link", { name: "DNS rule documentation" })).toHaveAttribute(
            "href",
            "https://sing-box.sagernet.org/configuration/dns/rule/",
        );

        // Options for the query without a server to send it to.
        await dialog.getByLabel("Action").selectOption("route-options");
        await expect(dialog.getByLabel("Server")).toHaveCount(0);
        await expect(dialog.getByLabel("Client subnet")).toBeVisible();

        // An answer made up on the node has records only while it is not an
        // error.
        await dialog.getByLabel("Action").selectOption("predefined");
        await dialog.getByLabel("Response code").selectOption("NXDOMAIN");
        await expect(dialog.getByLabel("Answers")).toHaveCount(0);
        await dialog.getByLabel("Response code").selectOption("NOERROR");
        await dialog.getByLabel("Answers").fill("a.com. IN A 127.0.0.1");

        // A logical rule combines rules of its own, each in a block, and says
        // how.
        await dialog.getByRole("switch", { name: "Logical" }).press("Space");
        await dialog.getByRole("button", { name: "Add rule" }).click();
        await expect(dialog.getByRole("region", { name: /^Rule \d$/ })).toHaveCount(2);
        await dialog.getByLabel("Mode").selectOption("or");
        await dialog.getByRole("button", { name: "Delete rule 2" }).click();
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => dnsIn(state).rules[2])
            .toEqual({
                type: "logical",
                mode: "or",
                rules: [{}],
                action: "predefined",
                rcode: "NOERROR",
                answer: ["a.com. IN A 127.0.0.1"],
            });
    });

    test("deletes a DNS rule once asked on its card", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false, baseConfig: dnsConfig() });

        await page.goto("/dns");
        await page.getByRole("button", { name: "Delete rule 1" }).click();

        const question = page.getByRole("alertdialog", { name: "Delete" });

        await expect(question).toContainText("goes on to the rules after it");
        await question.getByRole("button", { name: "Yes" }).click();

        // What was second is first now, and the card that was asking has gone
        // rather than handing its question on to the one after it.
        await expect(
            page.getByRole("list", { name: "DNS rules" }).getByRole("listitem"),
        ).toHaveCount(1);
        await expect(cardValue(page, "DNS rules", "1", "Server")).toHaveText("google");
        await expect(page.getByRole("alertdialog")).toBeHidden();
    });

    test("sets how every query is resolved, and saves it", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false, baseConfig: dnsConfig() };

        await mockApi(page, state);

        await page.goto("/dns");
        await page.getByLabel("Final").selectOption("cloudflare-dot");
        await page.getByLabel("Client subnet").fill("1.2.3.0/24");
        await page.getByLabel("Disable cache").check();

        const save = page.getByRole("button", { name: "Save", exact: true });

        await save.click();
        await expect(save).toBeDisabled();

        expect(dnsIn(state)).toMatchObject({
            final: "cloudflare-dot",
            client_subnet: "1.2.3.0/24",
            disable_cache: true,
        });
    });

    test("says how a listener is served, and edits its TLS where it is kept", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");

        // Read off the block the listener carries rather than a configuration
        // it names.
        await expect(cardValue(page, "Listeners", "edge", "Security")).toHaveText("TLS");

        await page.getByLabel("Edit edge", { exact: true }).click();

        const tls = page.getByRole("dialog").getByRole("region", { name: "TLS" });

        await expect(tls.getByLabel("Security")).toHaveValue("tls");
        await expect(tls.getByLabel("Certificate file path")).toHaveValue("/etc/cert.pem");
        await expect(tls.getByLabel("Key file path")).toHaveValue("/etc/key.pem");
    });

    test("serves a new listener over TLS from files on the node", async ({ page }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");
        const tls = dialog.getByRole("region", { name: "TLS" });

        await dialog.getByLabel("Type").selectOption("trojan");
        await dialog.getByLabel("Tag").fill("secure");
        await dialog.getByLabel("Port", { exact: true }).fill("8443");
        await tls.getByLabel("Security").selectOption("tls");
        await tls.getByLabel("Certificate file path").fill("/etc/other.pem");
        await tls.getByLabel("Key file path").fill("/etc/other.key");
        await tls.getByRole("switch", { name: "Allow insecure" }).press("Space");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        // What the listener terminates with among its options, as the core
        // reads it, and what a client is told beside the rest of what it is told.
        expect(state.inbounds?.find((inbound) => inbound.tag === "secure")).toMatchObject({
            type: "trojan",
            listen_port: 8443,
            tls: {
                enabled: true,
                certificate_path: "/etc/other.pem",
                key_path: "/etc/other.key",
            },
            out_json: { tls: { insecure: true } },
        });
    });

    test("lays out a listener's TLS and Reality as the reference does", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");
        const tls = dialog.getByRole("region", { name: "TLS" });

        await dialog.getByLabel("Type").selectOption("vless");
        await tls.getByLabel("Security").selectOption("tls");

        // Plain TLS starts with a certificate path or its text, and what a
        // client is told about verifying it.
        await expect(tls.getByLabel("Certificate file path")).toBeVisible();
        await expect(tls.getByRole("switch", { name: "Disable SNI" })).toBeVisible();
        await expect(dialog.getByRole("region", { name: "ECH" })).toBeVisible();

        // Groups of options switched on from the foot of the block, as the
        // reference's menu has them.
        await tls.getByRole("button", { name: "TLS options" }).click();
        await page.getByRole("menuitemcheckbox", { name: "ALPN" }).click();
        await page.getByRole("menuitemcheckbox", { name: "Minimum version" }).click();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await expect(tls.getByLabel("Minimum version")).toHaveValue("1.2");
        await expect(tls.getByRole("button", { name: /^ALPN/ })).toContainText("H3H2Http/1.1");

        // Reality starts afresh, with a handshake to borrow and keys to make,
        // and without encrypted client hellos, which the core refuses beside it.
        await tls.getByLabel("Security").selectOption("reality");
        await expect(tls.getByLabel("Server port")).toHaveValue("443");
        await expect(tls.getByLabel("Minimum version")).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "ECH" })).toHaveCount(0);
        await tls.getByRole("button", { name: "Generate a Reality key pair" }).click();
        await expect(tls.getByLabel("Private key")).toHaveValue("reality-private");
        await expect(tls.getByLabel("Public key")).toHaveValue("reality-public");

        await tls.getByRole("button", { name: "TLS options" }).click();
        await expect(page.getByRole("menuitemcheckbox")).toHaveText([
            "Max time difference",
            "Handshake timeout",
        ]);
    });

    test("serves a listener over Reality, keeping the public key for its clients", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");
        const tls = dialog.getByRole("region", { name: "TLS" });

        await dialog.getByLabel("Type").selectOption("vless");
        await dialog.getByLabel("Tag").fill("borrowed");
        await dialog.getByLabel("Port", { exact: true }).fill("443");
        await tls.getByLabel("Security").selectOption("reality");
        await tls.getByLabel("Handshake server").fill("www.apple.com");
        await tls.getByRole("button", { name: "Generate a Reality key pair" }).click();
        await expect(tls.getByLabel("Public key")).toHaveValue("reality-public");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        // The private key stays with the listener; the public key and the
        // fingerprint are what a client is handed to meet it.
        expect(state.inbounds?.find((inbound) => inbound.tag === "borrowed")).toMatchObject({
            tls: {
                enabled: true,
                reality: {
                    enabled: true,
                    handshake: { server: "www.apple.com", server_port: 443 },
                    private_key: "reality-private",
                },
            },
            out_json: {
                tls: {
                    reality: { public_key: "reality-public" },
                    utls: { enabled: true, fingerprint: "chrome" },
                },
            },
        });
        await expect(cardValue(page, "Listeners", "borrowed", "Security")).toHaveText("Reality");
    });

    test("generates a self-signed certificate for the name a listener answers for", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByRole("button", { name: "Add inbound" }).click();

        const dialog = page.getByRole("dialog");
        const tls = dialog.getByRole("region", { name: "TLS" });

        await dialog.getByLabel("Type").selectOption("trojan");
        await dialog.getByLabel("Tag").fill("self-signed");
        await tls.getByLabel("Security").selectOption("tls");
        await tls.getByRole("button", { name: "TLS options" }).click();
        await page.getByRole("menuitemcheckbox", { name: "SNI", exact: true }).click();
        await page.keyboard.press("Escape");
        await tls.getByLabel("SNI", { exact: true }).fill("edge.example.com");
        await tls.getByRole("button", { name: "Generate a self-signed certificate" }).click();

        // Held as text, since there is no file of it on the node.
        await expect(tls.getByRole("button", { name: "Use text" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        await expect(tls.getByLabel("Certificate", { exact: true })).toHaveValue(
            /for edge\.example\.com/,
        );
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.inbounds?.find((inbound) => inbound.tag === "self-signed")?.tls).toEqual({
            enabled: true,
            server_name: "edge.example.com",
            certificate: [
                "-----BEGIN CERTIFICATE-----",
                "for edge.example.com",
                "-----END CERTIFICATE-----",
            ],
            key: ["-----BEGIN PRIVATE KEY-----", "secret", "-----END PRIVATE KEY-----"],
        });
    });

    test("amends a listener's TLS without dropping what it has no field for", async ({ page }) => {
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            inbounds: [
                {
                    id: 1,
                    type: "vless",
                    tag: "edge",
                    listen_port: 443,
                    tls: {
                        enabled: true,
                        server_name: "edge.example.com",
                        certificate_path: "/etc/cert.pem",
                        key_path: "/etc/key.pem",
                        curve_preferences: ["x25519"],
                    },
                },
            ],
        };
        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByLabel("Edit edge", { exact: true }).click();

        const dialog = page.getByRole("dialog");
        const tls = dialog.getByRole("region", { name: "TLS" });

        // Read into the fields that show it, and the rest carried as it was.
        await expect(tls.getByLabel("SNI", { exact: true })).toHaveValue("edge.example.com");
        await expect(tls.getByLabel("Certificate file path")).toHaveValue("/etc/cert.pem");
        await tls.getByLabel("SNI", { exact: true }).fill("www.example.com");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(state.inbounds?.[0].tls).toEqual({
            enabled: true,
            server_name: "www.example.com",
            certificate_path: "/etc/cert.pem",
            key_path: "/etc/key.pem",
            curve_preferences: ["x25519"],
        });
    });

    test("lets a listener's TLS go when it is served in the clear", async ({ page }) => {
        const state: ApiState = {
            signedIn: true,
            maintenance: false,
            inbounds: [
                {
                    id: 1,
                    type: "vless",
                    tag: "edge",
                    listen_port: 443,
                    tls: { enabled: true, certificate_path: "/etc/cert.pem" },
                    out_json: { tls: { insecure: true }, server_ports: ["443:445"] },
                },
            ],
        };

        await mockApi(page, state);

        await page.goto("/inbounds");
        await page.getByLabel("Edit edge", { exact: true }).click();

        const dialog = page.getByRole("dialog");

        await dialog
            .getByRole("region", { name: "TLS" })
            .getByLabel("Security")
            .selectOption("none");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        // Both halves go, and what else a client is told stays.
        expect(state.inbounds?.[0]).not.toHaveProperty("tls");
        expect(state.inbounds?.[0].out_json).toEqual({ server_ports: ["443:445"] });
        await expect(cardValue(page, "Listeners", "edge", "Security")).toHaveText("None");
    });

    // The clock and shared HTTP clients have separate tabs under Settings.
    const basicsState = (): ApiState => ({
        signedIn: true,
        maintenance: false,
        baseConfig: { log: { level: "info" }, dns: { servers: [] }, experimental: {} },
    });

    test("keeps a clock only while it is switched on", async ({ page }) => {
        const state = basicsState();

        await mockApi(page, state);

        await page.goto("/general/settings?tab=ntp");
        const ntp = page.getByRole("tabpanel", { name: "NTP" });

        await ntp.getByRole("switch", { name: "Enabled" }).press("Space");
        // It starts where the reference starts one.
        await expect(ntp.getByLabel("Server")).toHaveValue("time.apple.com");
        await expect(ntp.getByLabel("Interval (minutes)")).toHaveValue("30");

        const save = ntp.getByRole("button", { name: "Save", exact: true });

        await save.click();
        await expect(save).toBeDisabled();
        expect(state.baseConfig?.ntp).toEqual({
            server: "time.apple.com",
            server_port: 123,
            interval: "30m",
            enabled: true,
        });

        await ntp.getByRole("switch", { name: "Enabled" }).press("Space");
        await save.click();
        await expect(save).toBeDisabled();
        expect(state.baseConfig).not.toHaveProperty("ntp");
    });

    test("adds a shared HTTP client", async ({ page }) => {
        const state = basicsState();

        await mockApi(page, state);

        await page.goto("/general/settings?tab=http-clients");
        const clients = page.getByRole("tabpanel", { name: "HTTP Clients" });
        await clients.getByRole("button", { name: "Add HTTP client" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Tag").fill("downloads");
        await dialog.getByLabel("HTTP version").selectOption("2");
        await dialog.getByLabel("Detour").selectOption("upstream");
        await dialog.getByRole("button", { name: "Add client" }).click();

        const table = clients.getByRole("table", { name: "HTTP clients" });

        await expect(table.getByRole("row", { name: /downloads/ })).toContainText("HTTP/2");

        await clients.getByRole("button", { name: "Save", exact: true }).click();

        await expect
            .poll(() => state.baseConfig?.http_clients)
            .toEqual([{ tag: "downloads", version: 2, detour: "upstream" }]);
    });

    test("orders the HTTP clients by a column, and edits the one pressed", async ({ page }) => {
        const state = basicsState();

        state.baseConfig = {
            ...state.baseConfig,
            http_clients: [{ tag: "zeta" }, { tag: "alpha", version: 1 }],
        };
        await mockApi(page, state);

        await page.goto("/general/settings?tab=http-clients");
        const clients = page.getByRole("tabpanel", { name: "HTTP Clients" });
        const table = clients.getByRole("table", { name: "HTTP clients" });

        await table.getByRole("button", { name: "Tag", exact: true }).click();
        await expect(table.getByRole("columnheader", { name: "Tag" })).toHaveAttribute(
            "aria-sort",
            "ascending",
        );
        await expect(table.getByRole("rowheader")).toHaveText(["alpha", "zeta"]);

        await table.getByRole("button", { name: "Edit zeta" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Engine").selectOption("go");
        await dialog.getByRole("button", { name: "Done" }).click();
        await clients.getByRole("button", { name: "Save", exact: true }).click();

        // The document keeps its clients in the order they were added.
        await expect
            .poll(() => state.baseConfig?.http_clients)
            .toEqual([
                { tag: "zeta", engine: "go" },
                { tag: "alpha", version: 1 },
            ]);
    });

    test("saves NTP and HTTP clients independently across settings tabs", async ({ page }) => {
        const state = basicsState();
        await mockApi(page, state);

        await page.goto("/general/settings?tab=ntp");
        const ntp = page.getByRole("tabpanel", { name: "NTP" });
        await ntp.getByRole("switch", { name: "Enabled" }).press("Space");
        await ntp.getByLabel("Server").fill("time.example.com");

        await page.getByRole("tab", { name: "HTTP Clients" }).click();
        const clients = page.getByRole("tabpanel", { name: "HTTP Clients" });
        await clients.getByRole("button", { name: "Add HTTP client" }).click();
        await page.getByRole("dialog").getByLabel("Tag").fill("downloads");
        await page.getByRole("dialog").getByRole("button", { name: "Add client" }).click();
        await clients.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => state.baseConfig?.http_clients).toEqual([{ tag: "downloads" }]);
        expect(state.baseConfig).not.toHaveProperty("ntp");

        await page.getByRole("tab", { name: "NTP", exact: true }).click();
        await expect(ntp.getByLabel("Server")).toHaveValue("time.example.com");
        await ntp.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => state.baseConfig?.ntp)
            .toEqual({
                server: "time.example.com",
                server_port: 123,
                interval: "30m",
                enabled: true,
            });
        expect(state.baseConfig?.http_clients).toEqual([{ tag: "downloads" }]);
        expect(state.baseConfig?.log).toEqual({ level: "info" });
        expect(state.baseConfig?.dns).toEqual({ servers: [] });
        expect(state.baseConfig?.experimental).toEqual({});
    });

    // Routing is the base document's route section, read and written the way
    // DNS is. The routes out are "out" (direct), "upstream" (socks) and "wg0",
    // a WireGuard tunnel.
    const routeConfig = () => ({
        log: { level: "info" },
        dns: { servers: [{ type: "local", tag: "local" }] },
        route: {
            final: "upstream",
            default_domain_resolver: "local",
            auto_detect_interface: true,
            rule_set: [
                {
                    type: "remote",
                    tag: "geosite-ads",
                    format: "binary",
                    url: "https://example.com/category-ads-all.srs",
                    http_client: { detour: "upstream" },
                    update_interval: "1d",
                },
                { type: "local", tag: "blocklist", format: "source", path: "/etc/blocklist.json" },
            ],
            rules: [
                { action: "sniff" },
                { rule_set: ["geosite-ads"], action: "reject" },
                {
                    type: "logical",
                    mode: "or",
                    rules: [{ domain_suffix: [".cn"] }, { ip_is_private: true }],
                    action: "route",
                    outbound: "out",
                },
            ],
        },
    });

    interface RouteDocument {
        rules: { action?: string; outbound?: string }[];
        rule_set: { tag: string }[];
        [option: string]: unknown;
    }

    const routeIn = (state: ApiState) => state.baseConfig?.route as RouteDocument;

    const routeState = (): ApiState => ({
        signedIn: true,
        maintenance: false,
        baseConfig: routeConfig(),
        outbounds: [
            { id: 1, type: "direct", tag: "out" },
            { id: 2, type: "socks", tag: "upstream", server: "10.0.0.2", server_port: 1080 },
            { id: 3, type: "wireguard", tag: "wg0", address: ["10.9.0.2/32"] },
        ],
    });

    test("shows a node's rule sets and rules as cards", async ({ page }) => {
        await mockApi(page, routeState());

        await page.goto("/rules");

        await expect(namedCard(page, "Rule sets", "geosite-ads")).toContainText("Remote");
        await expect(cardValue(page, "Rule sets", "geosite-ads", "Outbound")).toHaveText(
            "upstream",
        );
        await expect(cardValue(page, "Rule sets", "blocklist", "Update")).toHaveText("—");

        await expect(namedCard(page, "Rules", "3")).toContainText("Logical (or)");
        await expect(cardValue(page, "Rules", "3", "Outbound")).toHaveText("out");
        await expect(cardValue(page, "Rules", "2", "Rules")).toHaveText("1");

        await expect(page.getByLabel("Default outbound")).toHaveValue("upstream");
        await expect(page.getByRole("switch", { name: "Auto-bind interface" })).toBeChecked();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    });

    test("adds a rule, and writes it only when saved", async ({ page }) => {
        const state = routeState();

        await mockApi(page, state);

        await page.goto("/rules");
        await page.getByRole("button", { name: "Add rule", exact: true }).click();

        const dialog = page.getByRole("dialog");

        // A new rule is checked after existing rules.
        await expect(dialog.getByLabel("Position")).toHaveCount(0);
        await dialog.getByLabel("Outbound", { exact: true }).selectOption("wg0");

        // What it matches is switched on in the reference's groups.
        await dialog.getByRole("button", { name: "Rule options" }).click();
        await page.getByRole("menuitemcheckbox", { name: "Domain/IP" }).click();
        await page.keyboard.press("Escape");
        await dialog.getByLabel("Domain/IP").selectOption("domain_suffix");
        await dialog.getByLabel("Domain suffixes").fill(".internal\n.lan");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(cardValue(page, "Rules", "4", "Outbound")).toHaveText("wg0");
        expect(routeIn(state).rules).toHaveLength(3);

        const save = page.getByRole("button", { name: "Save", exact: true });

        await save.click();
        await expect(save).toBeDisabled();

        expect(routeIn(state).rules[3]).toEqual({
            domain_suffix: [".internal", ".lan"],
            action: "route",
            outbound: "wg0",
        });
        // The rest of the document goes back as it came.
        expect(state.baseConfig?.dns).toEqual({ servers: [{ type: "local", tag: "local" }] });
    });

    test("edits a remote rule set without adding another", async ({ page }) => {
        const state = routeState();

        await mockApi(page, state);

        await page.goto("/rules");
        await page.getByRole("button", { name: "Edit geosite-ads", exact: true }).click();

        const dialog = page.getByRole("dialog");

        await expect(dialog).toHaveAccessibleName("Edit rule set");
        await expect(dialog.getByLabel("Type")).toHaveValue("remote");
        await expect(dialog.getByLabel("Tag")).toHaveValue("geosite-ads");
        await expect(dialog.getByLabel("Tag")).toBeDisabled();
        await expect(dialog.getByLabel("Outbound")).toHaveValue("upstream");

        await dialog.getByLabel("URL").fill("https://example.com/geosite-ads.srs");
        await dialog.getByLabel("Outbound").selectOption("wg0");
        await dialog.getByLabel("Update interval (days)").fill("7");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        expect(routeIn(state).rule_set).toEqual(routeConfig().route.rule_set);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => routeIn(state).rule_set)
            .toEqual([
                {
                    type: "remote",
                    tag: "geosite-ads",
                    format: "binary",
                    url: "https://example.com/geosite-ads.srs",
                    http_client: { detour: "wg0" },
                    update_interval: "7d",
                },
                routeConfig().route.rule_set[1],
            ]);
    });

    test("lays out the rule dialog as the reference does", async ({ page }) => {
        const state = routeState();

        await mockApi(page, state);

        await page.goto("/rules");
        await page.getByRole("button", { name: "Add rule", exact: true }).click();

        const dialog = page.getByRole("dialog");

        // A simple rule, what it matches, what it does, and the block the action
        // takes.
        await expect(dialog.getByRole("switch", { name: "Logical" })).not.toBeChecked();
        await expect(dialog.getByRole("region", { name: "Conditions" })).toHaveCount(1);
        await expect(dialog.getByRole("region", { name: "Route", exact: true })).toBeVisible();

        // Each action its own block, and some none.
        await dialog.getByLabel("Action").selectOption("sniff");
        await expect(dialog.getByRole("region", { name: "Sniff", exact: true })).toBeVisible();
        await dialog.getByLabel("Action").selectOption("hijack-dns");
        await expect(dialog.getByRole("region", { name: "Sniff", exact: true })).toHaveCount(0);

        // A logical rule combines rules of its own, each in a block, and says
        // how.
        await dialog.getByRole("switch", { name: "Logical" }).press("Space");
        await dialog.getByRole("button", { name: "Add rule" }).click();
        await expect(dialog.getByRole("region", { name: /^Rule \d$/ })).toHaveCount(2);
        await dialog.getByLabel("Mode").selectOption("or");
        await dialog.getByRole("button", { name: "Delete rule 1" }).click();
        await expect(dialog.getByRole("region", { name: /^Rule \d$/ })).toHaveCount(1);
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => routeIn(state).rules[3])
            .toEqual({ type: "logical", mode: "or", rules: [{}], action: "hijack-dns" });
    });

    test("reorders the rules by dragging one onto another", async ({ page }) => {
        const state = routeState();

        await mockApi(page, state);

        await page.goto("/rules");

        const rules = page.getByRole("list", { name: "Rules" }).getByRole("listitem");

        await rules.nth(2).dragTo(rules.nth(0));

        await expect(cardValue(page, "Rules", "1", "Outbound")).toHaveText("out");
        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect
            .poll(() => routeIn(state).rules.map((rule) => rule.action))
            .toEqual(["route", "sniff", "reject"]);
    });

    test("edits a route rule without changing its place", async ({ page }) => {
        const state = routeState();

        await mockApi(page, state);
        await page.goto("/rules");
        await page.getByRole("button", { name: "Edit rule 2" }).click();

        const dialog = page.getByRole("dialog");
        await expect(dialog.getByLabel("Position")).toHaveCount(0);
        await dialog.getByLabel("Action").selectOption("hijack-dns");
        await dialog.getByRole("button", { name: "Save" }).click();

        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
            .poll(() => routeIn(state).rules.map((rule) => rule.action))
            .toEqual(["sniff", "hijack-dns", "route"]);
    });

    test("deletes a rule set once asked on its card", async ({ page }) => {
        const state = routeState();

        await mockApi(page, state);

        await page.goto("/rules");
        await page.getByRole("button", { name: "Delete blocklist", exact: true }).click();

        const question = namedCard(page, "Rule sets", "blocklist").getByRole("alertdialog", {
            name: "Delete",
        });

        await expect(question).toContainText("naming nothing");
        await question.getByRole("button", { name: "Yes" }).click();
        await expect(namedCard(page, "Rule sets", "blocklist")).toBeHidden();

        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect
            .poll(() => routeIn(state).rule_set.map((ruleSet) => ruleSet.tag))
            .toEqual(["geosite-ads"]);
    });

    test("sets where what no rule matches goes, and saves it", async ({ page }) => {
        const state = routeState();

        await mockApi(page, state);

        await page.goto("/rules");
        await page.getByLabel("Default outbound").selectOption("out");
        await page.getByLabel("Default routing mark").fill("255");
        await page.getByRole("switch", { name: "Auto-bind interface" }).press("Space");

        const save = page.getByRole("button", { name: "Save", exact: true });

        await save.click();
        await expect(save).toBeDisabled();

        expect(routeIn(state)).toMatchObject({ final: "out", default_mark: 255 });
        // Switched off, it is taken out of the document rather than written false.
        expect(routeIn(state)).not.toHaveProperty("auto_detect_interface");
    });

    test("sends what no rule matches to a block route", async ({ page }) => {
        // What a block route is for: the default outbound is named as a route
        // out, and naming a block one has a node refuse whatever no rule let
        // through.
        const state: ApiState = {
            ...routeState(),
            outbounds: [
                { id: 1, type: "direct", tag: "out" },
                { id: 2, type: "block", tag: "blocked" },
            ],
        };

        await mockApi(page, state);

        await page.goto("/rules");
        await page.getByLabel("Default outbound").selectOption("blocked");
        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect.poll(() => routeIn(state).final).toBe("blocked");
    });

    test("imports rules from a pasted configuration, leaving out a rule set it has", async ({
        page,
    }) => {
        const state = routeState();

        await mockApi(page, state);

        await page.goto("/rules");
        await page.getByRole("button", { name: "Tools" }).click();
        await page.getByRole("menuitem", { name: "Import rules" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Configuration").fill(
            JSON.stringify({
                route: {
                    rules: [{ protocol: "dns", action: "hijack-dns" }],
                    rule_set: [
                        { type: "remote", tag: "geosite-ads", format: "binary", url: "x" },
                        { type: "local", tag: "allowlist", format: "source", path: "/a" },
                    ],
                    final: "out",
                },
            }),
        );

        await expect(dialog).toContainText("1 rule and 2 rule sets");
        await expect(dialog).toContainText("One rule set is left out");
        await dialog.getByLabel("Send what no rule matches to out, as it does").check();
        await dialog.getByRole("button", { name: "Import" }).click();

        await expect(cardValue(page, "Rules", "4", "Action")).toHaveText("hijack-dns");
        await expect(namedCard(page, "Rule sets", "allowlist")).toBeVisible();
        await expect(page.getByLabel("Default outbound")).toHaveValue("out");

        await page.getByRole("button", { name: "Save", exact: true }).click();

        await expect
            .poll(() => routeIn(state).rule_set.map((ruleSet) => ruleSet.tag))
            .toEqual(["geosite-ads", "blocklist", "allowlist"]);
    });

    test("adds preset rule sets with a rule sending them to one route out", async ({ page }) => {
        await mockApi(page, routeState());

        await page.goto("/rules");
        await page.getByRole("button", { name: "Tools" }).click();
        await page.getByRole("menuitem", { name: "Preset rule sets" }).click();

        const dialog = page.getByRole("dialog");

        await dialog.getByLabel("Site-YouTube").check();
        await dialog.getByLabel("Add a rule sending them to one route out").check();
        await dialog.getByLabel("Route to").selectOption("upstream");
        await dialog.getByRole("button", { name: "Add", exact: true }).click();

        await expect(cardValue(page, "Rule sets", "geosite-youtube", "Update")).toHaveText("1d");
        await expect(cardValue(page, "Rules", "4", "Outbound")).toHaveText("upstream");
    });

    test("imports rule sets from a list of addresses", async ({ page }) => {
        await mockApi(page, routeState());

        await page.goto("/rules");
        await page.getByRole("button", { name: "Tools" }).click();
        await page.getByRole("menuitem", { name: "Import rule sets" }).click();

        const dialog = page.getByRole("dialog");

        await dialog
            .getByLabel("Addresses")
            .fill(
                "https://example.com/geoip-telegram.srs\nhttps://example.com/category-ads-all.srs",
            );
        await dialog.getByLabel("Outbound").selectOption("upstream");
        await dialog.getByRole("button", { name: "Add rule sets" }).click();

        await expect(cardValue(page, "Rule sets", "geoip-telegram", "Outbound")).toHaveText(
            "upstream",
        );
        await expect(namedCard(page, "Rule sets", "category-ads-all")).toBeVisible();
    });

    test("shows when a tunnel's traffic went, as any route out's is shown", async ({ page }) => {
        await mockApi(page, {
            signedIn: true,
            maintenance: false,
            outbounds: [
                { id: 1, type: "direct", tag: "out" },
                { id: 2, type: "wireguard", tag: "wg0", address: ["10.9.0.2/32"] },
            ],
        });

        await page.goto("/outbounds");

        const asked = page.waitForRequest((request) => request.url().includes("/stats?"));

        await page.getByRole("button", { name: "Traffic for wg0", exact: true }).click();

        // The core runs the tunnel as an endpoint, and reports what went through
        // it under its tag as it reports a route out's.
        expect(new URL((await asked).url()).searchParams.get("resource")).toBe("outbound");

        const dialog = page.getByRole("dialog");

        await expect(dialog).toContainText("wg0");
        await expect(dialog.getByText("over the last 6 hours")).toBeVisible();
    });

    test("shows when a subscriber's traffic went, not just how much is left", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        // Exact: the reset button beside it is "Reset traffic for alice".
        await page.getByLabel("Traffic for alice", { exact: true }).click();

        const dialog = page.getByRole("dialog");

        // Both directions, added from the series the API downsampled.
        await expect(dialog.getByText("over the last 6 hours")).toBeVisible();
        await expect(dialog.getByText("down ·", { exact: false })).toBeVisible();
    });

    test("shows a QR code beside the subscription link", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");
        await page.getByLabel("Connection links for alice").click();

        // A subscriber is usually holding the phone the subscription is for.
        await expect(page.getByLabel("Subscription link for alice")).toBeVisible();
    });

    test("shows the log the process has been keeping", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");
        await page.getByRole("button", { name: "Logs", exact: true }).click();

        const logs = page.getByRole("dialog");

        await expect(logs.getByText("x-ui dev starting")).toBeVisible();
        // Said on screen, because an empty log after a restart is not a quiet
        // panel.
        await expect(logs.getByText("This process only")).toBeVisible();

        // Filtered by the API rather than in the browser, so what is asked for
        // is what comes back.
        await logs.getByLabel("Level").selectOption("error");

        await expect(logs.getByText("node edge stopped reporting")).toBeVisible();
        await expect(logs.getByText("x-ui dev starting")).toBeHidden();
    });

    test("mints an API token and shows the value once", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/admins");
        await page.getByRole("button", { name: "API tokens" }).click();

        const form = page.getByRole("dialog").getByRole("form", { name: "Mint a token" });
        await form.getByLabel("What it is for").fill("deploy script");
        await form.getByRole("button", { name: "Mint a token" }).click();

        await expect(page.getByText("tok_live_abcdef123456")).toBeVisible();
        await expect(page.getByText("this is the only time it is shown")).toBeVisible();

        // Masked in the listing, which is the whole reason it is shown above.
        await expect(page.getByText("****")).toBeVisible();
    });

    test("takes a backup from the overview, and restores one as the API reads it", async ({
        page,
    }) => {
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/overview");
        await page.getByRole("button", { name: "Backup & restore" }).click();

        const dialog = page.getByRole("dialog", { name: "Backup & restore" });
        const file = dialog.locator("input[type=file]");

        // History is left out until it is asked for, and what a restore costs is
        // said before one is made.
        await expect(dialog.getByRole("link", { name: "Download a backup" })).toHaveAttribute(
            "href",
            "/api/backup?exclude=stats,changes",
        );
        await expect(dialog.getByText("operator accounts included")).toBeVisible();

        // A file that was never a backup is not sent to an endpoint that
        // replaces every table.
        await file.setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("not a backup"),
        });
        await expect(dialog.getByText("not a backup this panel can read")).toBeVisible();
        expect(state.restored).toBeUndefined();

        // One that is goes up as the file field the API reads a restore from, and
        // the dialog says it landed.
        await file.setInputFiles({
            name: "x-ui.backup.json",
            mimeType: "application/json",
            buffer: Buffer.from('{"takenAt": 1700000000}'),
        });
        await expect(dialog.getByText("Restored. Sign in again to carry on.")).toBeVisible();
        expect(state.restored).toContain('name="backup"');
        expect(state.restored).toContain('{"takenAt": 1700000000}');
    });

    test("changes your own credentials in the reference's dialog", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/admins");
        await page.getByRole("button", { name: "Edit your credentials" }).click();

        const dialog = page.getByRole("dialog", { name: "Change credentials operator" });
        const newPassword = dialog.getByLabel("New password", { exact: true });

        // Narrow, a filled field to a row, and the username carried in, so a new
        // password is all it takes.
        await settled(dialog);
        expect((await dialog.boundingBox())!.width).toBe(400);
        await expect(dialog.getByLabel("New username")).toHaveValue("operator");

        // What is missing is said on the line under the field, which is kept
        // whether or not anything is said on it, so nothing moves.
        const before = (await newPassword.boundingBox())!;

        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByText("Enter your current password.")).toBeVisible();
        expect((await newPassword.boundingBox())!.y).toBe(before.y);

        // The API is the authority on the current password.
        await dialog.getByLabel("Current password").fill("wrong-horse");
        await newPassword.fill("battery-staple");
        await dialog.getByLabel("New password again").fill("battery-staple");
        await dialog.getByRole("button", { name: "Save" }).click();
        await expect(dialog.getByText("wrong password")).toBeVisible();

        // The right one ends the session, and the panel lands back on sign in.
        await dialog.getByLabel("Current password").fill("correct-horse");
        await dialog.getByRole("button", { name: "Save" }).click();

        await expect(page).toHaveURL(/\/signin$/);
    });

    test("shows each operator's last sign-in on a card of their own", async ({ page }) => {
        await mockApi(page, {
            signedIn: true,
            maintenance: false,
            users: [
                {
                    id: 1,
                    username: "operator",
                    lastSignIn: "2026-03-14 09:00:00 203.0.113.10",
                    createdAt: 1_700_000_000,
                    twoFactor: false,
                },
                {
                    id: 2,
                    username: "ops",
                    lastSignIn: "",
                    createdAt: 1_700_000_000,
                    twoFactor: true,
                },
            ],
        });

        await page.goto("/admins");

        await expect(cardValue(page, "Operators", "operator", "Date")).toHaveText("2026-03-14");
        await expect(cardValue(page, "Operators", "operator", "Time")).toHaveText("09:00:00");
        await expect(cardValue(page, "Operators", "operator", "IP")).toHaveText("203.0.113.10");
        // Never signed in to, and not the account signed in: nothing to show, and
        // no credentials of theirs to change from here.
        await expect(cardValue(page, "Operators", "ops", "Date")).toHaveText("—");
        await expect(namedCard(page, "Operators", "ops").getByRole("button")).toHaveCount(1);
        // Whether each takes a code at sign-in as well.
        await expect(cardValue(page, "Operators", "operator", "Two-factor")).toHaveText("Off");
        await expect(cardValue(page, "Operators", "ops", "Two-factor")).toHaveText("On");
    });

    test("shows one operator's changes from their card", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/admins");
        await page.getByRole("button", { name: "Changes by operator" }).click();

        const dialog = page.getByRole("dialog", { name: "Changes by operator" });

        // Narrowed by the API to theirs, so a job's changes are not among them.
        await expect(dialog.getByText("inbounds")).toBeVisible();
        await expect(dialog.getByText("DepleteJob")).toBeHidden();
    });

    test("leads the old addresses of the account and the tokens to the admins page", async ({
        page,
    }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/general/account");
        await expect(page).toHaveURL(/\/admins$/);

        await page.goto("/general/tokens");
        await expect(page).toHaveURL(/\/admins$/);
    });

    test("picks up a change made elsewhere without a reload", async ({ page }) => {
        // A subscriber the worker disabled after they ran out of quota. Nobody
        // touched this panel, so nothing here would ever have asked again.
        const state: ApiState = { signedIn: true, maintenance: false };

        await mockApi(page, state);

        await page.goto("/clients");

        const enabled = page
            .getByRole("table", { name: "Subscribers" })
            .getByRole("switch", { name: "Enable alice" });

        await expect(enabled).toBeChecked();

        state.clients = [{ ...client, enable: false }];
        state.changed = true;

        await expect(enabled).not.toBeChecked({ timeout: 20_000 });
    });

    test("remembers a theme across a reload", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");
        await page.getByRole("button", { name: "Colour theme" }).click();
        await page.getByRole("menuitemradio", { name: "Dark" }).click();

        // Kept per browser rather than per account, so it survives a reload
        // without the API being asked anything.
        await page.reload();
        await page.getByRole("button", { name: "Colour theme" }).click();
        await expect(page.getByRole("menuitemradio", { name: "Dark" })).toBeChecked();
    });

    test("moves between pages from the rail", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");
        await page.getByRole("link", { name: "Clients" }).click();

        await expect(page).toHaveURL(/\/clients$/);
    });

    test("marks the page an operator is on, and only that one", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");

        const rail = page.getByRole("navigation", { name: "Panel" });

        // General starts folded, including when one of its pages is current.
        await expect(rail.getByRole("button", { name: "General" })).toHaveAttribute(
            "aria-expanded",
            "false",
        );
        await rail.getByRole("button", { name: "General" }).click();
        await rail.getByRole("link", { name: "Settings" }).click();

        await expect(page).toHaveURL(/\/general\/settings$/);
        await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

        // One current page in the rail, not two: /general is a prefix of the page
        // that is open, and does not get to claim it.
        await expect(rail.locator("[aria-current='page']")).toHaveCount(1);
        await expect(rail.locator("[aria-current='page']")).toHaveText("Settings");
    });

    test("keeps the rail to its icons until it is expanded from the app bar", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");

        const rail = page.getByRole("complementary");
        const table = page.getByRole("table", { name: "Subscribers" });

        await expect(table).toBeVisible();

        const tableBox = (await table.boundingBox())!;

        // Narrow enough for its icons and nothing else...
        expect((await rail.boundingBox())!.width).toBe(56);

        // ...and kept so with the pointer on it and with the keyboard in it: the
        // button in the app bar is the one thing that widens it.
        await rail.hover();
        await expect(rail).not.toHaveAttribute("data-expanded");
        await page.keyboard.press("Tab");
        await expect(rail.getByRole("link", { name: "Overview" })).toBeFocused();
        await expect(rail).not.toHaveAttribute("data-expanded");

        expect((await rail.boundingBox())!.width).toBe(56);
        expect((await table.boundingBox())!.x).toBe(tableBox.x);
    });

    test("expands the rail from the app bar, and collapses it again", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/clients");

        const rail = page.getByRole("complementary");
        const table = page.getByRole("table", { name: "Subscribers" });

        await expect(table).toBeVisible();

        const tableBox = (await table.boundingBox())!;

        await page.getByRole("button", { name: "Expand navigation" }).click();
        await page.mouse.move(900, 600);

        // Expanded, it stays so with the pointer elsewhere, and the page is moved
        // along by the room it takes rather than left underneath it.
        await expect.poll(async () => (await rail.boundingBox())!.width).toBe(256);
        await expect.poll(async () => (await table.boundingBox())!.x).toBe(tableBox.x + 200);
        await expect(page.getByRole("button", { name: "Collapse navigation" })).toHaveAttribute(
            "aria-expanded",
            "true",
        );

        // Kept per browser, as the theme is.
        await page.reload();
        await expect.poll(async () => (await rail.boundingBox())!.width).toBe(256);

        await page.getByRole("button", { name: "Collapse navigation" }).click();
        await page.mouse.move(900, 600);

        await expect.poll(async () => (await rail.boundingBox())!.width).toBe(56);
        await expect.poll(async () => (await table.boundingBox())!.x).toBe(tableBox.x);
    });

    test("names the pages the panel is worked in", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");

        const rail = page.getByRole("navigation", { name: "Panel" });

        await expect(rail.getByRole("link")).toHaveText([
            "Overview",
            "Inbounds",
            "Clients",
            "Outbounds",
            "Rules",
            "DNS",
        ]);

        await rail.getByRole("button", { name: "General" }).click();
        await expect(rail.getByRole("link")).toHaveText([
            "Overview",
            "Inbounds",
            "Clients",
            "Outbounds",
            "Rules",
            "DNS",
            "Admins",
            "Settings",
        ]);
    });

    test("keeps the operators and the settings under General", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/admins");

        const rail = page.getByRole("navigation", { name: "Panel" });
        const general = rail.getByRole("button", { name: "General" });
        const pages = rail.locator(`#${await general.getAttribute("aria-controls")}`);

        // Folded, its pages are hidden and the heading marks the current page.
        await expect(general).toHaveAttribute("aria-expanded", "false");
        await expect(rail.getByRole("link", { name: "Admins" })).toHaveCount(0);
        const currentFill = await general.evaluate(
            (heading) => getComputedStyle(heading).backgroundColor,
        );

        await general.click();
        await expect(general).toHaveAttribute("aria-expanded", "true");
        await expect(pages.getByRole("link")).toHaveText(["Admins", "Settings"]);
        await expect(rail.getByRole("link", { name: "Admins" })).toHaveCSS(
            "background-color",
            currentFill,
        );

        await general.click();
        await expect(general).toHaveAttribute("aria-expanded", "false");
        await expect(rail.getByRole("link", { name: "Admins" })).toHaveCount(0);
        await expect(general).toHaveCSS("background-color", currentFill);

        // The fold is kept in the browser, as the rail's width is.
        await page.reload();
        await expect(rail.getByRole("button", { name: "General" })).toHaveAttribute(
            "aria-expanded",
            "false",
        );

        await rail.getByRole("button", { name: "General" }).click();
        await rail.getByRole("link", { name: "Settings" }).click();

        await expect(page).toHaveURL(/\/general\/settings$/);
        await expect(rail.locator("[aria-current='page']")).toHaveText("Settings");
    });

    test("folds General once when upgrading saved navigation settings", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });
        await page.goto("/overview");
        await page.evaluate(() =>
            localStorage.setItem(
                "x-ui.sidebar",
                JSON.stringify({ state: { isExpanded: true, foldedGroups: [] }, version: 0 }),
            ),
        );

        await page.reload();

        const rail = page.getByRole("complementary");
        await expect(rail).toHaveAttribute("data-expanded", "");
        await expect(rail.getByRole("button", { name: "General" })).toHaveAttribute(
            "aria-expanded",
            "false",
        );

        await rail.getByRole("button", { name: "General" }).click();
        await page.reload();
        await expect(rail.getByRole("button", { name: "General" })).toHaveAttribute(
            "aria-expanded",
            "true",
        );
    });

    test("says maintenance is on from whichever page is open", async ({ page }) => {
        // The flag outlives a restart, and a panel serving nobody looks like any
        // other panel from anywhere but the switch that set it.
        await mockApi(page, { signedIn: true, maintenance: true });

        await page.goto("/clients");

        const maintenance = page.getByRole("banner").getByRole("link", { name: "Maintenance" });

        await expect(maintenance).toBeVisible();

        // And it leads to the one page it can be turned off from.
        await maintenance.click();

        await expect(page).toHaveURL(/\/overview$/);
    });

    test("brings the pages out from the app bar on a narrow screen", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");

        // There is no room for a rail beside the page, so the pages are a press
        // away rather than standing in view.
        await expect(page.getByRole("navigation", { name: "Panel" })).toBeHidden();

        await page.getByRole("button", { name: "Open navigation" }).click();

        const drawer = page.getByRole("dialog");

        await drawer.getByRole("link", { name: "Clients" }).click();

        // Picking a page is what puts the drawer away again.
        await expect(page).toHaveURL(/\/clients$/);
        await expect(drawer).toBeHidden();
    });
});
