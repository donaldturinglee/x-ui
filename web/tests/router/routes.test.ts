import { describe, expect, it } from "vitest";

import { getRoutePath, routes } from "@/router/routes";

describe("routes", () => {
    it("gives every page a unique key and path", () => {
        // A redirect names the route it leads to rather than its path, so a
        // duplicate key would silently send people to the wrong page.
        const keys = new Set(routes.map((route) => route.key));
        const paths = new Set(routes.map((route) => route.path));

        expect(keys.size).toBe(routes.length);
        expect(paths.size).toBe(routes.length);
    });

    it("resolves a route to its path", () => {
        expect(getRoutePath("overview")).toBe("/overview");
        expect(getRoutePath("signin")).toBe("/signin");
    });

    it("leaves only sign in reachable without a session", () => {
        // Every other page reads something that belongs to an operator, so
        // anything public here would be a page serving it to anyone.
        const publicRoutes = routes.filter((route) => route.access === "public");

        expect(publicRoutes.map((route) => route.key)).toEqual(["signin"]);
    });

    it("starts every path at the root", () => {
        for (const route of routes) {
            expect(route.path.startsWith("/")).toBe(true);
        }
    });

    it("names every page for the app bar", () => {
        // The shell says which page is open by the name its route carries, so a
        // route without one would open its page under an empty bar.
        for (const route of routes) {
            expect(route.title.trim()).not.toBe("");
        }
    });
});
