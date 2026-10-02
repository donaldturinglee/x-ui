import { LocaleProvider, Spinner, ThemeProvider } from "@gamecrafters/base-ui/react";
import { Suspense } from "react";
import {
    Outlet,
    RouterProvider,
    ScrollRestoration,
    createBrowserRouter,
    redirect,
    type RouteObject,
} from "react-router";

import { AppShell } from "@/components/AppShell";
import { AuthProvider } from "@/providers/auth/AuthProvider";
import { settings } from "@/settings";
import { useThemeStore } from "@/stores/theme";

import { Route } from "./Route";
import { getRoutePath, routes, type RouteHandle } from "./routes";

const LazyFallback = () => {
    return (
        <div className="flex min-h-dvh items-center justify-center">
            <Spinner />
        </div>
    );
};

const RootLayout = () => {
    const colorMode = useThemeStore((state) => state.colorMode);

    return (
        // How a byte count reads, how a timestamp is written and the order a
        // column sorts in are all settled against a locale, and the design
        // system reads one off this provider rather than reaching for the
        // browser's wherever it happens to need it. Naming it here is what gives
        // every table and dialog below the same one.
        <LocaleProvider>
            {/* Every page is drawn on the recessed ground, and the bars, the rail and
                the cards stand on the default one above it, so a surface reads as
                raised off the page in either scheme. */}
            <ThemeProvider
                colorMode={colorMode}
                className="min-h-dvh bg-[var(--background-color-inset)]"
            >
                <ScrollRestoration />
                <AuthProvider>
                    <Suspense fallback={<LazyFallback />}>
                        <Outlet />
                    </Suspense>
                </AuthProvider>

                {/* An overlay is portalled out of the tree it was opened from,
                    and the design system hangs its colours off the element this
                    provider renders, so one landing at the end of the body would
                    come out with none of them. Marking a home for the portal
                    inside the provider is what the design system looks for. */}
                <div data-portal-root />
            </ThemeProvider>
        </LocaleProvider>
    );
};

export const buildRoutes = (): RouteObject[] => [
    {
        path: "/",
        Component: RootLayout,
        children: [
            {
                index: true,
                loader: () => {
                    throw redirect(getRoutePath("overview"));
                },
            },
            // Signing in has nowhere to lead yet, so it stands on its own rather than
            // inside the shell.
            ...routes
                .filter((route) => route.access === "public")
                .map(({ path, title, component, access }): RouteObject => ({
                    path,
                    handle: { title } satisfies RouteHandle,
                    element: <Route component={component} access={access} />,
                })),
            // Every page behind a session is drawn inside the one shell, which stays
            // mounted while the pages change under it: the rail keeps whatever state
            // it was left in, and the live poll is not started over on every
            // navigation. Guarding the shell guards everything drawn inside it.
            {
                element: <Route component={AppShell} access="protected" />,
                children: routes
                    .filter((route) => route.access === "protected")
                    .map(({ path, title, component: Component }): RouteObject => ({
                        path,
                        handle: { title } satisfies RouteHandle,
                        element: <Component />,
                    })),
            },
        ],
    },
];

let browserRouter: ReturnType<typeof createBrowserRouter> | null = null;

export const Router = () => {
    // The server's runtime base is shared by the assets, routes and API calls.
    browserRouter ??= createBrowserRouter(buildRoutes(), {
        basename: settings.basePath.replace(/\/$/, ""),
    });

    return <RouterProvider router={browserRouter} />;
};
