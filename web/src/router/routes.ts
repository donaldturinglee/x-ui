import { lazy, type ComponentType } from "react";

// A public route is reachable signed out; a protected one needs a session and is
// sent back to sign in without one.
export type RouteAccess = "public" | "protected";

export interface Route {
    key: string;
    path: string;
    // What the page is called. The app bar says it for whichever page is open, so a
    // page holds only what it shows and the name it goes by stays beside its path.
    title: string;
    component: ComponentType;
    access: RouteAccess;
}

// What a route carries through to the router, so the shell around a page can read the
// name off whichever route matched rather than being told it by the page.
export interface RouteHandle {
    title: string;
}

// Every page the panel serves and nothing else, so what a route says about
// itself is all this file holds and the router is built from it elsewhere.
//
// A page is fetched on the way to it rather than up front, so arriving at one
// does not carry the code for the rest. Each page exports itself by name, so the
// import is mapped to the default export `lazy` reads.
export const routes = [
    {
        key: "signin",
        path: "/signin",
        title: "Sign in",
        component: lazy(() =>
            import("@/features/auth/Signin").then(({ Signin }) => ({ default: Signin })),
        ),
        access: "public",
    },
    {
        key: "overview",
        path: "/overview",
        title: "Overview",
        component: lazy(() =>
            import("@/features/overview/Overview").then(({ Overview }) => ({
                default: Overview,
            })),
        ),
        access: "protected",
    },
    {
        key: "clients",
        path: "/clients",
        title: "Clients",
        component: lazy(() =>
            import("@/features/clients/Clients").then(({ Clients }) => ({
                default: Clients,
            })),
        ),
        access: "protected",
    },
    {
        key: "inbounds",
        path: "/inbounds",
        title: "Inbounds",
        component: lazy(() =>
            import("@/features/inbounds/Inbounds").then(({ Inbounds }) => ({
                default: Inbounds,
            })),
        ),
        access: "protected",
    },
    {
        key: "outbounds",
        path: "/outbounds",
        title: "Outbounds",
        component: lazy(() =>
            import("@/features/outbounds/Outbounds").then(({ Outbounds }) => ({
                default: Outbounds,
            })),
        ),
        access: "protected",
    },
    // The former Basics page leads to NTP, the first of its settings tabs.
    {
        key: "basics",
        path: "/basics",
        title: "Settings",
        component: lazy(() =>
            import("@/features/basics/Basics").then(({ Basics }) => ({ default: Basics })),
        ),
        access: "protected",
    },
    {
        key: "rules",
        path: "/rules",
        title: "Rules",
        component: lazy(() =>
            import("@/features/rules/Rules").then(({ Rules }) => ({ default: Rules })),
        ),
        access: "protected",
    },
    {
        key: "dns",
        path: "/dns",
        title: "DNS",
        component: lazy(() => import("@/features/dns/Dns").then(({ Dns }) => ({ default: Dns }))),
        access: "protected",
    },
    {
        key: "admins",
        path: "/admins",
        title: "Admins",
        component: lazy(() =>
            import("@/features/admins/Admins").then(({ Admins }) => ({ default: Admins })),
        ),
        access: "protected",
    },
    // The settings page's first address, from before it was kept under General.
    // It is kept so it leads there.
    {
        key: "settings",
        path: "/settings",
        title: "Settings",
        component: lazy(() =>
            import("@/features/general/GeneralIndex").then(({ GeneralIndex }) => ({
                default: GeneralIndex,
            })),
        ),
        access: "protected",
    },
    // General is where the pages about the panel rather than about the traffic
    // through it are kept. The settings page is the one under its path, and the
    // path on its own leads there.
    {
        key: "general",
        path: "/general",
        title: "General",
        component: lazy(() =>
            import("@/features/general/GeneralIndex").then(({ GeneralIndex }) => ({
                default: GeneralIndex,
            })),
        ),
        access: "protected",
    },
    // The panel's settings: its own, the subscription's, two-factor
    // authentication, the Telegram bot, the generated sing-box configuration, and
    // the core's experimental interfaces and its log, a tab each.
    {
        key: "generalSettings",
        path: "/general/settings",
        title: "Settings",
        component: lazy(() =>
            import("@/features/settings/Settings").then(({ Settings }) => ({
                default: Settings,
            })),
        ),
        access: "protected",
    },
    // Where the subscription's settings were a page of their own. It leads to
    // their tab of the settings page.
    {
        key: "generalSubscriptions",
        path: "/general/subscriptions",
        title: "Settings",
        component: lazy(() =>
            import("@/features/general/Subscriptions").then(({ Subscriptions }) => ({
                default: Subscriptions,
            })),
        ),
        access: "protected",
    },
    // The operator's account and the API tokens are on the admins page now. The
    // old addresses are kept so they lead there.
    {
        key: "generalAccount",
        path: "/general/account",
        title: "Admins",
        component: lazy(() =>
            import("@/features/general/Account").then(({ Account }) => ({
                default: Account,
            })),
        ),
        access: "protected",
    },
    {
        key: "generalTokens",
        path: "/general/tokens",
        title: "Admins",
        component: lazy(() =>
            import("@/features/general/Tokens").then(({ Tokens }) => ({
                default: Tokens,
            })),
        ),
        access: "protected",
    },
    // Reachable by its path but not from the rail, which names the pages the
    // panel is worked in. The log is read when something is being looked into
    // rather than as part of that work.
    {
        key: "audit",
        path: "/audit",
        title: "Audit",
        component: lazy(() =>
            import("@/features/audit/Audit").then(({ Audit }) => ({
                default: Audit,
            })),
        ),
        access: "protected",
    },
] as const satisfies readonly Route[];

export type RouteKey = (typeof routes)[number]["key"];

// A redirect names the route it leads to rather than its path, so moving a page
// stays a change to the table alone. The keys come from the table, so there is
// always one to find.
export const getRoutePath = (key: RouteKey) => {
    return routes.find((route) => route.key === key)!.path;
};
