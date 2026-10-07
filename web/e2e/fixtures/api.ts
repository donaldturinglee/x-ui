import type { Page, Route } from "@playwright/test";

import type { CoreRestartJob, CoreStatus } from "../../src/features/overview/api/core";
import type {
    CoreVersionCheck,
    CoreVersionStatus,
} from "../../src/features/overview/api/core-version";
import type { UpgradeJob, UpgradeStatus } from "../../src/features/overview/api/upgrade";
import type {
    PanelSettings,
    PanelSettingsState,
    PanelRestartJob,
} from "../../src/features/settings/api/panel";
import type {
    SubscriptionSettings,
    SubscriptionSettingsState,
} from "../../src/features/settings/api/subscription";
import { subscriptionPublicBase } from "../../src/features/settings/subscriptionUri";
import type { ClientSubscriptionInfo } from "../../src/features/clients/api";

// The suite answers every API call itself rather than bringing up a Go server
// and a database, so a run needs nothing but a browser and says exactly what
// the panel was given.

const envelope = (obj: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ success: true, msg: "", obj }),
});

const refusal = (status: number, msg: string) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({ success: false, msg, obj: null }),
});

export interface ApiState {
    // Whether the session cookie the panel would be carrying is one the API
    // recognises. Signing in flips it, which is what the suite drives.
    signedIn: boolean;
    maintenance: boolean;
    // Written by the settings form and read back by it, so a test can check
    // that a save landed rather than only that the form submitted.
    settings?: Record<string, string>;
    panelSettings?: PanelSettingsState;
    subscriptionSettings?: SubscriptionSettingsState;
    subscriptionSaves?: number;
    panelSaves?: number;
    panelRestarts?: number;
    panelRestartPolls?: number;
    panelRestartHold?: boolean;
    panelRestartOutcome?: "succeeded" | "rolled_back" | "failed";
    coreStatus?: CoreStatus;
    coreRestarts?: number;
    coreRestartPolls?: number;
    coreRestartHold?: boolean;
    coreRestartOutcome?: "succeeded" | "failed";
    coreRestartPhase?: "checking" | "restarting" | "verifying";
    coreVersions?: CoreVersionStatus;
    coreVersionCheck?: CoreVersionCheck;
    coreVersionChecks?: number;
    coreVersionStarts?: number;
    coreVersionPolls?: number;
    coreVersionHold?: boolean;
    coreVersionCheckFailure?: boolean;
    coreVersionOutcome?: "succeeded" | "rolled_back" | "failed";
    coreVersionNeedsRecovery?: boolean;
    upgrade?: UpgradeStatus;
    upgradeChecks?: number;
    upgradeStarts?: number;
    upgradePolls?: number;
    upgradeHold?: boolean;
    upgradeDisconnect?: boolean;
    upgradeUnauthorized?: boolean;
    upgradeCheckFailure?: boolean;
    upgradeOutcome?: "succeeded" | "rolled_back" | "failed";
    // Written, amended and taken away by the listeners table, and read back the
    // same way. Held as state rather than answered from a constant so a test
    // checks what the panel actually sent.
    inbounds?: Record<string, unknown>[];
    outbounds?: Record<string, unknown>[];
    clients?: (typeof client)[];
    clientSubscriptionInfo?: ClientSubscriptionInfo;
    subscriptionInfoFailure?: boolean;
    subscriptionUriFailure?: boolean;
    // Set by a test to say something moved elsewhere — the worker disabling a
    // depleted subscriber, another operator writing a listener. The next poll
    // reports it once and the panel asks for everything again.
    changed?: boolean;
    onlines?: { inbound: string[]; outbound: string[]; client: string[] };
    baseConfig?: Record<string, unknown>;
    tokens?: {
        id: number;
        desc: string;
        token: string;
        expiry: number;
        userId: number;
        createdAt: number;
    }[];
    // Every account, the one signed in (the operator below) among them.
    users?: (typeof operator)[];
    // The form a restore arrived as, so a test can check the file went up in the
    // field the API reads it from.
    restored?: string;
    // Whether signing in as the operator takes a code from an authenticator app
    // as well, which the settings turn on and off.
    twoFactor?: boolean;
    // How many test messages the Telegram bot was asked to send.
    telegramTests?: number;
}

// The one code the mock's authenticator app shows, and the secret it was set up
// with.
export const TWO_FACTOR_CODE = "123456";
export const TWO_FACTOR_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

// Everything a node is configured with that has no table of its own. Small on
// purpose: a test that needs more in it hands the mock a document of its own.
export const defaultBaseConfig: Record<string, unknown> = {
    log: { level: "info" },
    dns: { servers: [] },
};

export const defaultSettings: Record<string, string> = {
    subUpdates: "12",
    subEncode: "true",
    subShowInfo: "false",
    tgBotEnable: "false",
    tgBotToken: "",
    tgBotChatIds: "",
    tgNotifySignIn: "true",
    tgNotifyDeplete: "true",
};

// What the process read from configs/ when it started, as the settings page is
// shown it: the defaults, with no session secret set.
export const startupSettings = {
    panel: {
        listen: "",
        port: 8000,
        basePath: "/",
        domain: "",
        certFile: "",
        keyFile: "",
        trustedProxies: [],
    },
    subscription: {
        listen: "",
        port: 8443,
        basePath: "/sub/",
        domain: "sub.example.com",
        certFile: "",
        keyFile: "",
        trustedProxies: [],
        enabled: true,
        publicUrl: "",
    },
    session: { maxAgeSeconds: 0, secretSet: false },
    worker: {
        timeLocation: "UTC",
        depleteSpec: "@every 1m",
        resetSpec: "",
        cleanupSpec: "@daily",
        statsRetentionSeconds: 2_592_000,
        statsBucketSeconds: 60,
    },
    logLevel: "info",
};

export const defaultPanelSettings: PanelSettings = {
    ...startupSettings.panel,
    ...startupSettings.worker,
    maxAgeSeconds: startupSettings.session.maxAgeSeconds,
    logLevel: startupSettings.logLevel,
};

// A listener with an option the panel does not model, which is what an edit has
// to carry back untouched, served over TLS from a certificate on the node.
export const defaultInbounds: Record<string, unknown>[] = [
    {
        id: 1,
        type: "vless",
        tag: "edge",
        listen_port: 443,
        transport: { type: "ws", path: "/sub" },
        tls: { enabled: true, certificate_path: "/etc/cert.pem", key_path: "/etc/key.pem" },
    },
];

export const defaultOutbounds: Record<string, unknown>[] = [
    { id: 1, type: "direct", tag: "out" },
    { id: 2, type: "socks", tag: "upstream", server: "10.0.0.2", server_port: 1080 },
];

export const operator = {
    id: 1,
    username: "operator",
    lastSignIn: "2026-03-14 09:00:00 203.0.113.10",
    createdAt: 1_700_000_000,
    twoFactor: false,
};

export const client = {
    id: 1,
    enable: true,
    name: "alice",
    desc: "",
    group: "staff",
    volume: 10 * 1024 ** 3,
    expiry: 0,
    up: 1024 ** 3,
    down: 2 * 1024 ** 3,
    totalUp: 0,
    totalDown: 0,
    createdAt: 1_700_000_000,
    onlineAt: 0,
    delayStart: false,
    autoReset: false,
    resetDays: 0,
    nextReset: 0,
    // Connecting through the listener above, which is what an edit has to carry
    // back rather than quietly clear.
    inbounds: [1],
    // What they authenticate with there. Left out of the listing, as the API
    // leaves it out, and handed over with the subscriber read on their own.
    config: {
        vless: { name: "alice", uuid: "0f1e2d3c-4b5a-4968-8776-655443322110" },
    } as Record<string, Record<string, unknown>>,
};

const systemStatus = (maintenance: boolean) => ({
    app: {
        name: "x-ui",
        version: "test",
        go: "go1.27.1",
        os: "linux",
        arch: "amd64",
        goroutines: 12,
        heapBytes: 4_000_000,
        uptimeSeconds: 3_600,
        maintenance,
    },
    host: {
        hostname: "node-1",
        platform: "debian 12",
        cpus: 4,
        cpuModel: "AMD EPYC 7282",
        bootTime: 1_700_000_000,
    },
    cpuPercent: 12.5,
    memory: { current: 2 * 1024 ** 3, total: 8 * 1024 ** 3 },
    // A host with no swap reports the pair as nothing rather than leaving it
    // out, which is what the dial has to read as "not on this host".
    swap: { current: 0, total: 0 },
    disk: { current: 20 * 1024 ** 3, total: 100 * 1024 ** 3 },
    network: {
        bytesSent: 500 * 1024 ** 2,
        bytesRecv: 3 * 1024 ** 3,
        packetsSent: 1_200_000,
        packetsRecv: 3_400_000,
    },
    database: { clients: 1, inbounds: 1, outbounds: 2 },
});

const nextId = (records: Record<string, unknown>[] | undefined) =>
    Math.max(0, ...(records ?? []).map((record) => Number(record.id))) + 1;

const nextInboundId = (state: ApiState) => nextId(state.inbounds);

// The API takes a block route as its type and its tag alone, and names every
// other key it was sent: the core would refuse the whole configuration over one.
const refuseBlockOptions = (body: Record<string, unknown>) => {
    const stray = Object.keys(body)
        .filter((key) => body.type === "block" && !["id", "type", "tag"].includes(key))
        .sort();

    return stray.length
        ? refusal(
              400,
              stray.map((key) => `${key} is not an option a block outbound takes`).join("; "),
          )
        : null;
};

// A request for the API, matched from the root of the path. Every feature keeps
// its requests in an `api` module of its own, so a pattern finding `/api/`
// anywhere would answer the dev server's own requests for those modules too.
// mockApi answers the panel's reads and writes against a small piece of state
// the test can set up front and the panel can change through the UI.
export const mockApi = async (page: Page, state: ApiState, basePath = "/") => {
    state.settings ??= { ...defaultSettings };
    state.panelSettings ??= {
        saved: structuredClone(defaultPanelSettings),
        running: structuredClone(defaultPanelSettings),
        revision: "panel-0",
        overrides: {},
        restartRequired: false,
        restartSupported: true,
    };
    const defaultSubscription = {
        ...startupSettings.subscription,
        publicUrl: "https://sub.example.com",
    };
    state.subscriptionSettings ??= {
        saved: structuredClone(defaultSubscription),
        running: structuredClone(defaultSubscription),
        savedPanel: state.panelSettings.saved,
        runningPanel: state.panelSettings.running,
        revision: state.panelSettings.revision,
        overrides: {},
        pendingScopes: [],
        restartRequired: false,
        restartSupported: true,
        savedUri: "https://sub.example.com/sub/",
        runningUri: "https://sub.example.com/sub/",
    };
    const syncStartupSettings = () => {
        const panel = state.panelSettings!;
        const sub = state.subscriptionSettings!;
        const scopes: ("panel" | "subscription")[] = [];
        if (JSON.stringify(panel.saved) !== JSON.stringify(panel.running)) scopes.push("panel");
        if (JSON.stringify(sub.saved) !== JSON.stringify(sub.running)) scopes.push("subscription");
        panel.pendingScopes = scopes;
        panel.savedSubscription = sub.saved;
        panel.runningSubscription = sub.running;
        panel.restartRequired =
            scopes.length > 0 ||
            Boolean(
                panel.restartJob &&
                ["queued", "running", "rolling_back"].includes(panel.restartJob.state),
            );
        Object.assign(sub, {
            savedPanel: panel.saved,
            runningPanel: panel.running,
            revision: panel.revision,
            pendingScopes: scopes,
            restartRequired: panel.restartRequired,
            restartSupported: panel.restartSupported,
            restartUnavailableReason: panel.restartUnavailableReason,
            restartJob: panel.restartJob,
            savedUri: subscriptionPublicBase(sub.saved, "localhost"),
            runningUri: subscriptionPublicBase(sub.running, "localhost"),
        });
    };
    syncStartupSettings();
    state.inbounds ??= defaultInbounds.map((inbound) => ({ ...inbound }));
    state.outbounds ??= defaultOutbounds.map((outbound) => ({ ...outbound }));
    state.clients ??= [{ ...client }];
    state.baseConfig ??= { ...defaultBaseConfig };
    state.coreStatus ??= {
        supported: true,
        state: "active",
        pid: 4242,
        uptimeSeconds: 3600,
        currentVersion: "1.14.2",
    };
    state.coreVersions ??= {
        supported: state.coreStatus.supported,
        reason: state.coreStatus.reason,
        currentVersion: state.coreStatus.currentVersion ?? "1.14.2",
        packageVersion: "1.14.2",
        platform: "amd64",
        manager: "apt",
        configRevision: "core-version-revision",
        versions: ["1.14.2", "1.14.1", "1.14.0"].map((version, index) => ({
            id: index + 1,
            version,
            url: `https://github.com/SagerNet/sing-box/releases/tag/v${version}`,
            publishedAt: "2026-10-01T00:00:00Z",
            assetId: index + 10,
            assetName: `sing-box_${version}_linux_amd64.deb`,
            assetUrl: `https://github.com/SagerNet/sing-box/releases/download/v${version}/sing-box_${version}_linux_amd64.deb`,
            assetSize: 32000000,
            assetUpdatedAt: "2026-10-01T00:00:00Z",
            sha256: "a".repeat(64),
        })),
    };
    state.upgrade ??= {
        supported: true,
        currentVersion: "v0.0.1",
        platform: "amd64",
        checkState: "unchecked",
        configRevision: "upgrade-revision",
        canUpgrade: false,
        blockedReason: "Check for updates before upgrading.",
        components: ["API", "Worker", "CLI", "Web panel", "Database migrations"],
    };

    const isApiRequest = ({ pathname }: URL) => pathname.startsWith(`${basePath}api/`);

    await page.route(isApiRequest, async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname.slice(`${basePath}api`.length);
        const method = request.method();

        if (path === "/signin/config" && method === "GET") {
            await route.fulfill({
                ...envelope({ showTwoFactor: state.twoFactor ?? false }),
                headers: { "Cache-Control": "no-store" },
            });
            return;
        }

        if (path === "/signin" && method === "POST") {
            const body = request.postDataJSON() as {
                username?: string;
                password?: string;
                code?: string;
            };

            // The API answers every failed sign-in the same way whatever went
            // wrong, so the form cannot be used to find out which usernames
            // exist. The suite holds it to that.
            if (body.username !== "operator" || body.password !== "correct-horse") {
                await route.fulfill(refusal(401, "wrong username or password"));
                return;
            }

            // The password was right, and the account takes a code as well:
            // asked for with the question in the refusal's payload, as the API
            // asks, and a wrong one refused like a wrong password.
            if (state.twoFactor && !body.code) {
                await route.fulfill({
                    status: 401,
                    contentType: "application/json",
                    body: JSON.stringify({
                        success: false,
                        msg: "enter the code from your authenticator app",
                        obj: { twoFactor: true },
                    }),
                });
                return;
            }

            if (state.twoFactor && body.code !== TWO_FACTOR_CODE) {
                await route.fulfill(refusal(401, "wrong two-factor code"));
                return;
            }

            state.signedIn = true;
            await route.fulfill(envelope({ username: "operator" }));
            return;
        }

        if (path === "/signout" && method === "POST") {
            state.signedIn = false;
            await route.fulfill(envelope(null));
            return;
        }

        if (!state.signedIn) {
            await route.fulfill(refusal(401, "not signed in"));
            return;
        }

        if (path === "/me") {
            await route.fulfill(envelope({ ...operator, twoFactor: state.twoFactor ?? false }));
            return;
        }

        // The secret is handed out and kept nowhere until a code from the app
        // confirms it, and turning it off takes a code as well.
        if (path === "/me/two-factor/setup" && method === "POST") {
            await route.fulfill(
                envelope({
                    secret: TWO_FACTOR_SECRET,
                    uri: `otpauth://totp/x-ui:operator?secret=${TWO_FACTOR_SECRET}&issuer=x-ui`,
                }),
            );
            return;
        }

        const twoFactorChange = /^\/me\/two-factor\/(enable|disable)$/.exec(path)?.[1];

        if (twoFactorChange && method === "POST") {
            const body = request.postDataJSON() as { code?: string; secret?: string };

            if (body.code !== TWO_FACTOR_CODE) {
                await route.fulfill(refusal(400, "wrong two-factor code"));
                return;
            }

            state.twoFactor = twoFactorChange === "enable";
            await route.fulfill(envelope(null));
            return;
        }

        // A wrong current password is refused as the API refuses it, and the
        // right one ends the session, as the API ends it: the name the session
        // held may be the one that just changed.
        if (path === "/me/credentials" && method === "POST") {
            const body = request.postDataJSON() as { oldPassword?: string };

            if (body.oldPassword !== "correct-horse") {
                await route.fulfill(refusal(401, "wrong password"));
                return;
            }

            state.signedIn = false;
            await route.fulfill(envelope(null));
            return;
        }

        if (path === "/system") {
            await route.fulfill(envelope(systemStatus(state.maintenance)));
            return;
        }

        // The panel's one poll. `changed` is what tells it to ask for everything
        // again, so a test drives liveness by flipping this rather than by
        // waiting for a timer it does not control.
        if (path === "/load") {
            const changed = state.changed ?? false;

            // Reported once. A change the panel has already been told about is
            // not a reason to refetch on every pass afterwards.
            state.changed = false;

            await route.fulfill(
                envelope({
                    lu: changed ? 2 : 1,
                    changed,
                    maintenance: state.maintenance,
                    onlines: state.onlines ?? {
                        inbound: ["edge"],
                        outbound: [],
                        client: ["alice"],
                    },
                }),
            );
            return;
        }

        if (path === "/config/base" && method === "GET") {
            await route.fulfill(envelope(state.baseConfig));
            return;
        }

        if (path === "/config/base" && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;

            // The API refuses a key filled in from a table rather than ignoring
            // it, and the panel is meant to show what it said.
            const managed = ["inbounds", "outbounds", "endpoints"].filter((key) => key in body);

            if (managed.length > 0) {
                await route.fulfill(refusal(400, `${managed[0]} is filled in from its own table`));
                return;
            }

            state.baseConfig = body;
            await route.fulfill(envelope(body));
            return;
        }

        if (path === "/onlines") {
            await route.fulfill(envelope({ inbound: ["edge"], outbound: [], client: ["alice"] }));
            return;
        }

        // Read by the app bar on every page, alongside the flag the poll carries, so
        // the two have to agree for a test to be saying anything.
        if (path === "/maintenance" && method === "GET") {
            await route.fulfill(envelope({ maintenance: state.maintenance }));
            return;
        }

        if (path === "/maintenance" && method === "POST") {
            const body = request.postDataJSON() as { enable?: boolean };

            state.maintenance = Boolean(body.enable);
            await route.fulfill(envelope({ maintenance: state.maintenance }));
            return;
        }

        if (path === "/backup/restore" && method === "POST") {
            const body = request.postData() ?? "";

            // The API reads a restore from a file field named "backup" of a
            // multipart form, and refuses anything else, a JSON body included.
            if (
                !request.headers()["content-type"]?.startsWith("multipart/form-data") ||
                !body.includes('name="backup"')
            ) {
                await route.fulfill(
                    refusal(400, 'attach the backup as a file field named "backup"'),
                );
                return;
            }

            state.restored = body;
            await route.fulfill(envelope(null));
            return;
        }

        if (path === "/clients" && method === "GET") {
            // Narrowed by the API rather than by the panel, so a filter the
            // panel sends is one this has to honour for the test to mean
            // anything.
            const group = url.searchParams.get("group");
            const search = url.searchParams.get("search");
            const enabled = url.searchParams.get("enabled");

            const matches = (state.clients ?? []).filter((c) => {
                if (group && c.group !== group) return false;
                if (enabled !== null && String(c.enable) !== enabled) return false;
                if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
                return true;
            });

            const offset = Number(url.searchParams.get("offset") ?? 0);
            const limit = Number(url.searchParams.get("limit") ?? 100);

            await route.fulfill(
                envelope({
                    // A summary, as the API's is: the credentials stay out.
                    clients: matches
                        .slice(offset, offset + limit)
                        .map(({ config: _credentials, ...summary }) => summary),
                    total: matches.length,
                    limit,
                    offset,
                }),
            );
            return;
        }

        if (path === "/clients" && method === "POST") {
            const body = request.postDataJSON() as typeof client;

            // The name is the subscription id, so it is the API's to refuse
            // twice rather than the panel's.
            if ((state.clients ?? []).some((c) => c.name === body.name)) {
                await route.fulfill(refusal(409, `a client named ${body.name} already exists`));
                return;
            }

            // The counters and the times are the API's to write, whatever was
            // sent.
            const created = {
                ...body,
                id: nextId(state.clients),
                up: 0,
                down: 0,
                totalUp: 0,
                totalDown: 0,
                createdAt: 1_700_000_000,
                onlineAt: 0,
                nextReset: 0,
                config: body.config ?? {},
            };

            state.clients = [...(state.clients ?? []), created];
            await route.fulfill(envelope(created));
            return;
        }

        if (path === "/stats") {
            // Two buckets with traffic and the rest empty, which is what a real
            // series looks like: a quiet hour has no row at all.
            await route.fulfill(
                envelope({
                    stats: { "0": [1024, 2048], "3": [512, 4096] },
                    startTime: 1_700_000_000,
                    bucketSpan: 3_600,
                    numBuckets: 6,
                }),
            );
            return;
        }

        // Filtered and trimmed by the API rather than by the panel, so what the
        // dialog's two fields ask for is what this has to honour for a test of
        // them to be saying anything.
        if (path === "/logs") {
            const level = url.searchParams.get("level") ?? "info";
            const count = Number(url.searchParams.get("count") ?? 100);

            const lines =
                level === "error"
                    ? ["2026/09/15 04:01:00 ERROR - node edge stopped reporting"]
                    : [
                          "2026/09/15 04:00:00 INFO - x-ui dev starting",
                          "2026/09/15 04:00:01 INFO - listening on :8000",
                      ];

            await route.fulfill(envelope(lines.slice(0, count)));
            return;
        }

        if (path === "/tokens" && method === "GET") {
            await route.fulfill(envelope(state.tokens ?? []));
            return;
        }

        if (path === "/tokens" && method === "POST") {
            const body = request.postDataJSON() as { desc: string; expiryDays: number };
            const created = {
                id: nextId(state.tokens),
                desc: body.desc,
                // The only response that carries the value; everywhere else it
                // is masked, which is what the panel says on screen.
                token: "tok_live_abcdef123456",
                expiry: body.expiryDays ? 1_800_000_000 : 0,
                userId: 1,
                createdAt: 1_700_000_000,
            };

            state.tokens = [...(state.tokens ?? []), { ...created, token: "****" }];
            await route.fulfill(envelope(created));
            return;
        }

        const tokenId = /^\/tokens\/(\d+)$/.exec(path)?.[1];

        if (tokenId && method === "DELETE") {
            state.tokens = (state.tokens ?? []).filter((token) => token.id !== Number(tokenId));
            await route.fulfill(envelope(null));
            return;
        }

        if (path === "/subscription-uri") {
            if (state.subscriptionUriFailure) {
                await route.fulfill(refusal(500, "Unable to read the subscription address"));
                return;
            }
            await route.fulfill(
                envelope({
                    uri: state.subscriptionSettings!.runningUri,
                    enabled: state.subscriptionSettings!.running.enabled,
                }),
            );
            return;
        }

        if (path === "/client-groups") {
            const groups = new Set(
                (state.clients ?? []).map((c) => c.group).filter((g): g is string => Boolean(g)),
            );

            await route.fulfill(envelope([...groups]));
            return;
        }

        const clientId = /^\/clients\/(\d+)$/.exec(path)?.[1];

        // One subscriber whole, which is what a switch flipped from the table is
        // written back from.
        if (clientId && method === "GET") {
            const found = (state.clients ?? []).find((c) => c.id === Number(clientId));

            await route.fulfill(found ? envelope(found) : refusal(404, "client not found"));
            return;
        }

        if (clientId && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;

            // Replaced rather than merged, which is how an assignment the panel
            // dropped shows up here as one that is gone.
            state.clients = (state.clients ?? []).map((c) =>
                c.id === Number(clientId) ? { ...c, ...body, id: Number(clientId) } : c,
            );
            await route.fulfill(envelope({ ...body, id: Number(clientId) }));
            return;
        }

        if (clientId && method === "DELETE") {
            state.clients = (state.clients ?? []).filter((c) => c.id !== Number(clientId));
            await route.fulfill(envelope(null));
            return;
        }

        if (/^\/clients\/\d+\/reset-traffic$/.test(path) && method === "POST") {
            const id = Number(path.split("/")[2]);

            // The period is rolled into the lifetime totals rather than thrown
            // away, which is what the dialog promises.
            state.clients = (state.clients ?? []).map((c) =>
                c.id === id
                    ? {
                          ...c,
                          totalUp: c.totalUp + c.up,
                          totalDown: c.totalDown + c.down,
                          up: 0,
                          down: 0,
                      }
                    : c,
            );
            await route.fulfill(envelope(null));
            return;
        }

        // Every subscriber's period rolled over at once, and whoever was held
        // offline for running out let back on, which is what the API promises.
        if (path === "/traffic/reset" && method === "POST") {
            const touched = (state.clients ?? []).filter((c) => c.up + c.down > 0 || !c.enable);

            state.clients = (state.clients ?? []).map((c) => ({
                ...c,
                totalUp: c.totalUp + c.up,
                totalDown: c.totalDown + c.down,
                up: 0,
                down: 0,
                enable: true,
            }));
            await route.fulfill(envelope({ reset: touched.length }));
            return;
        }

        if (path === "/clients/1/subscription-info") {
            if (state.subscriptionInfoFailure) {
                await route.fulfill(refusal(500, "Unable to read subscription availability"));
                return;
            }
            await route.fulfill(
                envelope(
                    state.clientSubscriptionInfo ?? {
                        enabled: state.clients?.find(({ id }) => id === 1)?.enable ?? true,
                        formats: {
                            links: { nodeCount: 1, omittedProtocols: [] },
                            clash: { nodeCount: 1, omittedProtocols: [] },
                            json: { nodeCount: 1, omittedProtocols: [] },
                        },
                    },
                ),
            );
            return;
        }

        if (path === "/clients/1/links") {
            await route.fulfill(envelope(["vless://uuid@edge.example.com:443#alice"]));
            return;
        }

        if (path === "/inbounds" && method === "GET") {
            await route.fulfill(envelope(state.inbounds));
            return;
        }

        if (path === "/inbounds" && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;

            // The API refuses a duplicate tag, and the panel is meant to show
            // what it said rather than swallow it.
            if (state.inbounds?.some((inbound) => inbound.tag === body.tag)) {
                await route.fulfill(refusal(409, "a listener with that tag already exists"));
                return;
            }

            const created = { ...body, id: nextInboundId(state) };

            state.inbounds = [...(state.inbounds ?? []), created];
            await route.fulfill(envelope(created));
            return;
        }

        const inboundId = /^\/inbounds\/(\d+)$/.exec(path)?.[1];

        if (inboundId && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;

            if (
                state.inbounds?.some(
                    (inbound) => inbound.id !== Number(inboundId) && inbound.tag === body.tag,
                )
            ) {
                await route.fulfill(refusal(409, "a listener with that tag already exists"));
                return;
            }

            // Replaced rather than merged, which is what makes an option the
            // panel dropped show up here as one that is gone.
            state.inbounds = (state.inbounds ?? []).map((inbound) =>
                inbound.id === Number(inboundId) ? { ...body, id: Number(inboundId) } : inbound,
            );
            await route.fulfill(envelope({ ...body, id: Number(inboundId) }));
            return;
        }

        if (inboundId && method === "DELETE") {
            state.inbounds = (state.inbounds ?? []).filter(
                (inbound) => inbound.id !== Number(inboundId),
            );
            await route.fulfill(envelope(null));
            return;
        }

        if (path === "/outbounds" && method === "GET") {
            await route.fulfill(envelope(state.outbounds));
            return;
        }

        if (path === "/outbounds" && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;
            const refused = refuseBlockOptions(body);

            if (refused) {
                await route.fulfill(refused);
                return;
            }

            const created = { ...body, id: nextId(state.outbounds) };

            state.outbounds = [...(state.outbounds ?? []), created];
            await route.fulfill(envelope(created));
            return;
        }

        const outboundId = /^\/outbounds\/(\d+)$/.exec(path)?.[1];

        if (outboundId && method === "POST") {
            const body = request.postDataJSON() as Record<string, unknown>;
            const refused = refuseBlockOptions(body);

            if (refused) {
                await route.fulfill(refused);
                return;
            }

            // Replaced rather than merged, which is what makes an option the
            // panel dropped show up here as one that is gone.
            state.outbounds = (state.outbounds ?? []).map((outbound) =>
                outbound.id === Number(outboundId) ? { ...body, id: Number(outboundId) } : outbound,
            );
            await route.fulfill(envelope({ ...body, id: Number(outboundId) }));
            return;
        }

        if (outboundId && method === "DELETE") {
            // The API refuses to leave a node with no route out at all.
            if ((state.outbounds ?? []).length <= 1) {
                await route.fulfill(refusal(409, "the last outbound cannot be removed"));
                return;
            }

            state.outbounds = (state.outbounds ?? []).filter(
                (outbound) => outbound.id !== Number(outboundId),
            );
            await route.fulfill(envelope(null));
            return;
        }

        // Generated on the API, and handed back once: a self-signed certificate
        // for the name asked for, or a Reality or WireGuard key pair -- or, given
        // a WireGuard private key, the public key that goes with it, as the API
        // works it out. Fixed here, so a test can see where each landed.
        if (path === "/keypairs" && method === "GET") {
            const kind = url.searchParams.get("kind");
            const options = url.searchParams.get("options");

            await route.fulfill(
                kind === "tls"
                    ? envelope({
                          kind,
                          certificate: `-----BEGIN CERTIFICATE-----\nfor ${options || "localhost"}\n-----END CERTIFICATE-----\n`,
                          privateKey:
                              "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n",
                      })
                    : kind === "wireguard"
                      ? envelope(
                            options
                                ? { kind, publicKey: `public-of-${options}` }
                                : {
                                      kind,
                                      privateKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                                      publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
                                  },
                        )
                      : envelope({
                            kind,
                            privateKey: "reality-private",
                            publicKey: "reality-public",
                        }),
            );
            return;
        }

        // Every value is a string whatever it stands for, which is what the
        // panel reads them back out of.
        if (path === "/settings" && method === "GET") {
            await route.fulfill(envelope({ ...state.settings }));
            return;
        }

        if (path === "/settings" && method === "POST") {
            const body = request.postDataJSON() as Record<string, string>;

            state.settings = { ...state.settings, ...body };
            await route.fulfill(envelope({ ...state.settings }));
            return;
        }

        // The keys named go back to their defaults and nothing else, as the API
        // resets them; none named is every one.
        if (path === "/settings/reset" && method === "POST") {
            const keys = (request.postDataJSON() as { keys?: string[] } | null)?.keys ?? [];

            state.settings = keys.length
                ? {
                      ...state.settings,
                      ...Object.fromEntries(keys.map((key) => [key, defaultSettings[key]])),
                  }
                : { ...defaultSettings };
            await route.fulfill(envelope({ ...state.settings }));
            return;
        }

        if (path === "/settings/startup") {
            await route.fulfill(envelope(startupSettings));
            return;
        }

        if (path === "/upgrade" && method === "GET") {
            await route.fulfill(envelope(state.upgrade));
            return;
        }
        if (path === "/upgrade/check" && method === "POST") {
            state.upgradeChecks = (state.upgradeChecks ?? 0) + 1;
            const current = state.upgrade!;
            current.checkedAt = new Date().toISOString();
            current.checkId = "a".repeat(32);
            if (state.upgradeCheckFailure) {
                current.checkState = "failed";
                current.checkError =
                    "The release could not be checked. Check the host's GitHub connection and try again.";
                current.canUpgrade = false;
            } else {
                current.checkState = "checked";
                current.latest = {
                    id: 1,
                    version: "v0.0.2",
                    url: "https://github.com/donaldturinglee/x-ui/releases/tag/v0.0.2",
                    publishedAt: "2026-10-01T00:00:00Z",
                    assetId: 2,
                    assetName: "x-ui-linux-amd64.tar.gz",
                    assetUrl:
                        "https://github.com/donaldturinglee/x-ui/releases/download/v0.0.2/x-ui-linux-amd64.tar.gz",
                    assetSize: 1000,
                    assetUpdatedAt: "2026-10-01T00:00:00Z",
                    sha256: "0".repeat(64),
                };
                current.canUpgrade =
                    current.supported &&
                    current.currentVersion !== current.latest.version &&
                    !state.panelSettings?.restartRequired;
                current.blockedReason = !current.supported
                    ? current.reason
                    : state.panelSettings?.restartRequired
                      ? "Apply the saved Panel and Subscription settings before upgrading."
                      : current.canUpgrade
                        ? undefined
                        : "This installation is up to date.";
                current.checkError = undefined;
            }
            await route.fulfill(envelope(current));
            return;
        }
        if (path === "/upgrade" && method === "POST") {
            const current = state.upgrade!;
            const body = request.postDataJSON() as {
                checkId: string;
                expectedCurrentVersion: string;
                configRevision: string;
            };
            if (
                body.checkId !== current.checkId ||
                body.expectedCurrentVersion !== current.currentVersion ||
                body.configRevision !== current.configRevision
            ) {
                await route.fulfill(
                    refusal(409, "Version or configuration changed; check for updates again"),
                );
                return;
            }
            if (
                !current.job ||
                !["queued", "running", "rolling_back"].includes(current.job.state)
            ) {
                state.upgradeStarts = (state.upgradeStarts ?? 0) + 1;
                state.upgradePolls = 0;
                current.job = {
                    id: "b".repeat(32),
                    state: "queued",
                    phase: "scheduled",
                    actor: "operator",
                    fromVersion: current.currentVersion,
                    toVersion: current.latest!.version,
                    components: current.components,
                    requestedAt: new Date().toISOString(),
                    needsRecovery: false,
                } satisfies UpgradeJob;
                current.canUpgrade = false;
            }
            await route.fulfill({ ...envelope(current.job), status: 202 });
            return;
        }
        if (path.startsWith("/upgrade/jobs/") && method === "GET") {
            if (state.upgradeDisconnect) {
                await route.abort("connectionrefused");
                return;
            }
            if (state.upgradeUnauthorized) {
                await route.fulfill(refusal(401, "Session expired"));
                return;
            }
            const current = state.upgrade!;
            const job = current.job;
            if (!job || !path.endsWith(`/${job.id}`)) {
                await route.fulfill(refusal(404, "Upgrade task does not exist"));
                return;
            }
            if (["queued", "running", "rolling_back"].includes(job.state)) {
                state.upgradePolls = (state.upgradePolls ?? 0) + 1;
                job.state = "running";
                job.phase = state.upgradeHold ? "backing_up" : "verifying";
                if (!state.upgradeHold && state.upgradePolls >= 3) {
                    job.state = state.upgradeOutcome ?? "succeeded";
                    job.finishedAt = new Date().toISOString();
                    if (job.state === "succeeded") current.currentVersion = job.toVersion;
                    else
                        job.error =
                            job.state === "rolled_back"
                                ? "The upgrade failed. The previous version and database have been restored."
                                : "Database recovery failed. Services remain stopped and the backup was retained.";
                    job.needsRecovery = job.state === "failed";
                }
            }
            await route.fulfill(envelope(job));
            return;
        }

        if (path === "/core/versions" && method === "GET") {
            await route.fulfill(envelope(state.coreVersions));
            return;
        }
        if (path === "/core/version/check" && method === "POST") {
            state.coreVersionChecks = (state.coreVersionChecks ?? 0) + 1;
            const current = state.coreVersions!;
            const target = current.versions.find(
                (release) => release.version === request.postDataJSON().version,
            );
            if (state.coreVersionCheckFailure || !target) {
                await route.fulfill(
                    refusal(400, "The selected official release could not be verified."),
                );
                return;
            }
            state.coreVersionCheck = {
                checkId: "c".repeat(32),
                checkedAt: new Date().toISOString(),
                currentVersion: current.currentVersion,
                configRevision: current.configRevision,
                direction: target.version < current.currentVersion ? "downgrade" : "upgrade",
                target,
            };
            await route.fulfill(envelope(state.coreVersionCheck));
            return;
        }
        if (path === "/core/version" && method === "POST") {
            const current = state.coreVersions!;
            const checked = state.coreVersionCheck;
            const body = request.postDataJSON();
            if (
                !checked ||
                body.checkId !== checked.checkId ||
                body.expectedCurrentVersion !== current.currentVersion ||
                body.configRevision !== current.configRevision
            ) {
                await route.fulfill(
                    refusal(
                        409,
                        "Version or configuration changed. Check the selected version again.",
                    ),
                );
                return;
            }
            state.coreVersionStarts = (state.coreVersionStarts ?? 0) + 1;
            state.coreVersionPolls = 0;
            current.job = {
                id: String(state.coreVersionStarts).padStart(32, "0"),
                state: "queued",
                phase: "scheduled",
                direction: checked.direction,
                actor: "operator",
                fromVersion: checked.currentVersion,
                toVersion: checked.target.version,
                requestedAt: new Date().toISOString(),
                needsRecovery: false,
            };
            await route.fulfill({ ...envelope(current.job), status: 202 });
            return;
        }
        if (path.startsWith("/core/version/jobs/") && method === "GET") {
            const current = state.coreVersions!;
            const job = current.job;
            if (!job || !path.endsWith(`/${job.id}`)) {
                await route.fulfill(refusal(404, "Core version task does not exist"));
                return;
            }
            if (["queued", "running", "rolling_back"].includes(job.state)) {
                state.coreVersionPolls = (state.coreVersionPolls ?? 0) + 1;
                job.state = "running";
                job.phase = state.coreVersionHold ? "downloading" : "verifying";
                if (!state.coreVersionHold && state.coreVersionPolls >= 3) {
                    job.state = state.coreVersionOutcome ?? "succeeded";
                    job.finishedAt = new Date().toISOString();
                    if (job.state === "succeeded") {
                        current.currentVersion = current.packageVersion = job.toVersion;
                        state.coreStatus!.currentVersion = job.toVersion;
                        state.coreStatus!.pid++;
                    } else
                        job.error =
                            job.state === "rolled_back"
                                ? "The previous package, configuration and state were restored."
                                : "The selected version failed validation; sing-box was not stopped.";
                    job.needsRecovery = Boolean(state.coreVersionNeedsRecovery);
                }
            }
            await route.fulfill(envelope(job));
            return;
        }
        if (path === "/core" && method === "GET") {
            await route.fulfill(envelope(state.coreStatus));
            return;
        }

        if (path === "/core/logs" && method === "GET") {
            await route.fulfill(
                envelope({ lines: ["sing-box started", "Statistics API listening"] }),
            );
            return;
        }

        if (path === "/core/restart" && method === "POST") {
            const current = state.coreStatus!;
            if (!current.supported) {
                await route.fulfill(refusal(400, current.reason ?? "Core restart is unavailable"));
                return;
            }
            let job = current.restartJob;
            if (!job || ["succeeded", "failed"].includes(job.state)) {
                state.coreRestarts = (state.coreRestarts ?? 0) + 1;
                state.coreRestartPolls = 0;
                job = {
                    id: `core-${state.coreRestarts}`,
                    state: "queued",
                    actor: "operator",
                    requestedAt: new Date().toISOString(),
                    beforePid: current.pid,
                    afterPid: 0,
                } satisfies CoreRestartJob;
                current.restartJob = job;
            }
            await route.fulfill({ ...envelope(job), status: 202 });
            return;
        }

        if (path.startsWith("/core/restart/") && method === "GET") {
            const current = state.coreStatus!;
            const job = current.restartJob;
            if (!job || !path.endsWith(`/${job.id}`)) {
                await route.fulfill(refusal(404, "Core restart task does not exist"));
                return;
            }
            if (!["succeeded", "failed"].includes(job.state)) {
                state.coreRestartPolls = (state.coreRestartPolls ?? 0) + 1;
                if (state.coreRestartHold) job.state = state.coreRestartPhase ?? "checking";
                else if (state.coreRestartPolls < 4)
                    job.state =
                        state.coreRestartPolls === 1
                            ? "checking"
                            : state.coreRestartPolls === 2
                              ? "restarting"
                              : "verifying";
                else {
                    job.state = state.coreRestartOutcome ?? "succeeded";
                    job.finishedAt = new Date().toISOString();
                    if (job.state === "succeeded") {
                        job.afterPid = job.beforePid + 1;
                        current.pid = job.afterPid;
                        current.uptimeSeconds = 1;
                    } else
                        job.error =
                            "The current sing-box configuration failed validation; the service was not restarted.";
                }
            }
            await route.fulfill(envelope(job));
            return;
        }

        if (path === "/settings/panel" && method === "GET") {
            syncStartupSettings();
            await route.fulfill(envelope(state.panelSettings));
            return;
        }

        if (path === "/settings/panel" && method === "POST") {
            const body = request.postDataJSON() as { revision: string; values: PanelSettings };
            const current = state.panelSettings!;

            if (body.revision !== current.revision) {
                await route.fulfill(
                    refusal(
                        409,
                        "Configuration changed since you started editing. Discard changes and try again",
                    ),
                );
                return;
            }
            state.panelSaves = (state.panelSaves ?? 0) + 1;
            state.panelSettings = {
                ...current,
                saved: body.values,
                revision: `panel-${state.panelSaves}`,
                restartRequired: JSON.stringify(body.values) !== JSON.stringify(current.running),
            };
            syncStartupSettings();
            await route.fulfill(envelope(state.panelSettings));
            return;
        }

        if (path === "/settings/subscription" && method === "GET") {
            syncStartupSettings();
            await route.fulfill(envelope(state.subscriptionSettings));
            return;
        }
        if (path === "/settings/subscription" && method === "POST") {
            const body = request.postDataJSON() as {
                revision: string;
                values: SubscriptionSettings;
            };
            if (body.revision !== state.panelSettings!.revision) {
                await route.fulfill(
                    refusal(
                        409,
                        "Configuration changed since you started editing. Discard changes and try again",
                    ),
                );
                return;
            }
            state.subscriptionSaves = (state.subscriptionSaves ?? 0) + 1;
            state.subscriptionSettings!.saved = body.values;
            state.panelSettings!.revision = `subscription-${state.subscriptionSaves}`;
            syncStartupSettings();
            await route.fulfill(envelope(state.subscriptionSettings));
            return;
        }

        if (["/settings/panel/restart", "/settings/apply"].includes(path) && method === "POST") {
            syncStartupSettings();
            const current = state.panelSettings!;
            const body = request.postDataJSON() as { revision: string; scopes?: string[] };
            if (body.revision !== current.revision) {
                await route.fulfill(
                    refusal(409, "Configuration changed; refresh before applying it"),
                );
                return;
            }
            if (
                JSON.stringify((body.scopes ?? ["panel"]).toSorted()) !==
                JSON.stringify(current.pendingScopes)
            ) {
                await route.fulfill(
                    refusal(409, "Saved Panel and Subscription changes must be confirmed together"),
                );
                return;
            }
            state.panelRestarts = (state.panelRestarts ?? 0) + 1;
            state.panelRestartPolls = 0;
            const job: PanelRestartJob = {
                id: `restart-${state.panelRestarts}`,
                state: "queued",
                revision: current.revision,
                actor: "operator",
                requestedAt: new Date().toISOString(),
                values: structuredClone(current.saved),
                previous: structuredClone(current.running),
                subscription: structuredClone(state.subscriptionSettings!.saved),
                previousSubscription: structuredClone(state.subscriptionSettings!.running),
                scopes: current.pendingScopes,
            };
            current.restartJob = job;
            syncStartupSettings();
            await route.fulfill({ ...envelope(job), status: 202 });
            return;
        }

        if (
            (path.startsWith("/settings/panel/restart/") || path.startsWith("/settings/apply/")) &&
            method === "GET"
        ) {
            const current = state.panelSettings!;
            const job = current.restartJob;
            if (!job || !path.endsWith(`/${job.id}`)) {
                await route.fulfill(refusal(404, "Restart task does not exist"));
                return;
            }
            state.panelRestartPolls = (state.panelRestartPolls ?? 0) + 1;
            if (state.panelRestartHold || state.panelRestartPolls < 2) job.state = "running";
            else if (["queued", "running", "rolling_back"].includes(job.state)) {
                job.state = state.panelRestartOutcome ?? "succeeded";
                job.finishedAt = new Date().toISOString();
                if (job.state === "succeeded") {
                    current.running = structuredClone(job.values);
                    state.subscriptionSettings!.running = structuredClone(job.subscription!);
                    current.restartRequired = false;
                } else if (job.state === "rolled_back") {
                    current.saved = structuredClone(job.previous);
                    current.running = structuredClone(job.previous);
                    state.subscriptionSettings!.saved = structuredClone(job.previousSubscription!);
                    state.subscriptionSettings!.running = structuredClone(
                        job.previousSubscription!,
                    );
                    current.revision = `restored-${state.panelRestarts}`;
                    current.restartRequired = false;
                    job.error =
                        "The saved configuration could not be applied. The previous Panel configuration has been restored.";
                } else
                    job.error = "The services did not recover; check them from the command line.";
            }
            syncStartupSettings();
            await route.fulfill(envelope(job));
            return;
        }

        // Sent with the bot as it is saved, which the API refuses without a
        // token and a chat to send to.
        if (path === "/telegram/test" && method === "POST") {
            if (!state.settings?.tgBotToken || !state.settings.tgBotChatIds) {
                await route.fulfill(
                    refusal(400, "save the bot's token and at least one chat first"),
                );
                return;
            }

            state.telegramTests = (state.telegramTests ?? 0) + 1;
            await route.fulfill(envelope(null));
            return;
        }

        // The document a node fetches, assembled from what the mock holds, with
        // the listeners withheld in maintenance as the API withholds them.
        if (path === "/config") {
            await route.fulfill(
                envelope({
                    config: {
                        ...state.baseConfig,
                        inbounds: state.maintenance ? [] : state.inbounds,
                        outbounds: state.outbounds,
                    },
                    maintenance: state.maintenance,
                }),
            );
            return;
        }

        if (path === "/changes") {
            // Narrowed to one actor by the API rather than by the panel, so a
            // test of one operator's changes has to be given only theirs.
            const actor = url.searchParams.get("actor");
            const changes = [
                {
                    id: 2,
                    dateTime: 1_700_000_100,
                    actor: "DepleteJob",
                    key: "clients",
                    action: "disable",
                    obj: { id: 1, name: "alice" },
                },
                {
                    id: 1,
                    dateTime: 1_700_000_000,
                    actor: operator.username,
                    key: "inbounds",
                    action: "new",
                    obj: { id: 1, tag: "edge" },
                },
            ];

            await route.fulfill(
                envelope(actor ? changes.filter((change) => change.actor === actor) : changes),
            );
            return;
        }

        if (path === "/users") {
            await route.fulfill(
                envelope(state.users ?? [{ ...operator, twoFactor: state.twoFactor ?? false }]),
            );
            return;
        }

        await route.fulfill(envelope(null));
    });
};
