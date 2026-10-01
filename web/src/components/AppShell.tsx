import { Spinner } from "@gamecrafters/base-ui/react";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { Outlet, useLocation, useMatches } from "react-router";

import { useLive } from "@/lib/live";
import type { RouteHandle } from "@/router/routes";
import { useSidebarStore } from "@/stores/sidebar";

import { AppBar } from "./AppBar";
import { NavigationDrawer } from "./NavigationDrawer";

// Below this width a rail would take room the page cannot spare, so there is none,
// and the pages are reached from a drawer the app bar brings out instead. The app bar
// and the page make room for the rail from the same width in their own classes, so
// the three change over together.
const MOBILE_QUERY = "(width < 840px)";

const subscribeToWidth = (onChange: () => void) => {
    const query = window.matchMedia(MOBILE_QUERY);

    query.addEventListener("change", onChange);

    return () => query.removeEventListener("change", onChange);
};

const isMobileWidth = () => window.matchMedia(MOBILE_QUERY).matches;

// Every page inside the panel is laid out the same way, so the shell is written
// once here rather than repeated with small differences that turn into large
// ones. It is the layout the router draws every signed-in page inside, and it
// stays mounted while the pages change beneath it. A page says what it holds; the
// route it was drawn from says what it is called.
export const AppShell = () => {
    // Mounted here rather than per page, so there is one poll whichever page is
    // open and it survives navigating between them.
    useLive();

    const isMobile = useSyncExternalStore(subscribeToWidth, isMobileWidth);
    const isSidebarExpanded = useSidebarStore((state) => state.isExpanded);
    const { pathname } = useLocation();
    const matches = useMatches();
    const title = (matches.at(-1)?.handle as RouteHandle | undefined)?.title ?? "";

    // The drawer is out only on the page it was brought out on, so picking a page
    // from it is what puts it away, and nothing has to remember to close it.
    const [drawerPath, setDrawerPath] = useState<string | null>(null);
    const isDrawerOpen = isMobile && drawerPath === pathname;

    // Crossing the width puts it away as well, whichever way the window went, so it
    // does not come back out on its own the next time the window narrows.
    useEffect(() => subscribeToWidth(() => setDrawerPath(null)), []);

    // The shell is a stacking context of its own. The app bar and the rail stand
    // over the page inside it, and everything the design system portals out --
    // dialogs, menus, the drawer -- stands over the shell as a whole.
    return (
        <div className="isolate flex min-h-dvh flex-col">
            <NavigationDrawer
                isMobile={isMobile}
                isOpen={isDrawerOpen}
                onClose={() => setDrawerPath(null)}
            />

            <AppBar
                title={title}
                isMobile={isMobile}
                isDrawerOpen={isDrawerOpen}
                onOpenDrawer={() => setDrawerPath(pathname)}
            />

            {/* Held clear of the app bar, and of the rail where there is one, since
                both stand over the page rather than beside it. The rail is held
                clear of at whichever width the app bar has set it to, so the page
                moves along as it is expanded and back as it is collapsed. */}
            <main
                className={`m-2.5 flex-1 pt-16 transition-[padding-left] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${isSidebarExpanded ? "min-[840px]:pl-64" : "min-[840px]:pl-14"}`}
            >
                {/* A page is fetched on the way to it, so the shell is left standing
                    while it arrives rather than giving way to a spinner of its own. */}
                <Suspense
                    fallback={
                        <div className="flex justify-center py-8">
                            <Spinner />
                        </div>
                    }
                >
                    <Outlet />
                </Suspense>
            </main>
        </div>
    );
};
