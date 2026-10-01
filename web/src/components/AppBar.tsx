import { Badge, Heading, IconButton, Tooltip } from "@gamecrafters/base-ui/react";
import { NavigationRegular, WrenchRegular } from "@gamecrafters/base-ui-icons";
import { Link } from "react-router";

import { useMaintenance } from "@/features/overview/api";
import { getRoutePath } from "@/router/routes";
import { useSidebarStore } from "@/stores/sidebar";

import { ThemeControl } from "./ThemeControl";

interface AppBarProps {
    title: string;
    // A narrow screen has no rail to move between pages from, so the bar leads with
    // the button that brings the drawer out instead.
    isMobile: boolean;
    isDrawerOpen: boolean;
    onOpenDrawer: () => void;
}

// The band across the top of every page: the button that shows the pages, which
// page it is, whether the panel is serving anybody, and the theme. It stands clear
// of the rail rather than under it, and the page scrolls beneath it.
export const AppBar = ({ title, isMobile, isDrawerOpen, onOpenDrawer }: AppBarProps) => {
    const { data } = useMaintenance();

    // On a wide screen the rail is always there, so the button at the head of the
    // bar expands it to its full width instead of bringing anything out, and
    // collapses it back to its icons again. Nothing else changes its width.
    const isSidebarExpanded = useSidebarStore((state) => state.isExpanded);
    const expandSidebar = useSidebarStore((state) => state.expand);
    const collapseSidebar = useSidebarStore((state) => state.collapse);

    return (
        // Held in by the width of the rail from the width the shell switches at, which
        // is the same width the shell reads to decide there is a rail at all, and
        // moved along with the rail as it is opened and closed.
        <header
            className={`fixed top-0 right-0 left-0 z-[var(--z-index-sticky)] flex h-16 items-center overflow-hidden bg-[var(--background-color-default)] pr-1 shadow-[var(--shadow-resting-medium)] transition-[left] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${isSidebarExpanded ? "min-[840px]:left-64" : "min-[840px]:left-14"}`}
        >
            {/* The same mark in the same place either way, where the reference keeps
                the room for it, so the title does not move between the two. */}
            {isMobile ? (
                <IconButton
                    icon={<NavigationRegular size={24} />}
                    aria-label="Open navigation"
                    aria-expanded={isDrawerOpen}
                    variant="invisible"
                    className="size-6 text-[var(--foreground-color-default)]"
                    onClick={onOpenDrawer}
                />
            ) : (
                <IconButton
                    icon={<NavigationRegular size={24} />}
                    aria-label={isSidebarExpanded ? "Collapse navigation" : "Expand navigation"}
                    aria-expanded={isSidebarExpanded}
                    variant="invisible"
                    className="size-6 text-[var(--foreground-color-default)]"
                    onClick={isSidebarExpanded ? collapseSidebar : expandSidebar}
                />
            )}

            <Heading
                as="h1"
                size="medium"
                className="ml-5 min-w-0 flex-1 truncate text-center leading-7 font-normal"
            >
                {title}
            </Heading>

            {/* Said on every page rather than only beside the switch, because the flag
                outlives a restart and a panel serving nobody looks like any other
                panel from wherever an operator happens to be. It leads to the switch
                that turns it off. */}
            {data?.maintenance && (
                <Tooltip text="Nodes are withholding every listener, so no subscriber can connect until maintenance is turned off.">
                    <Badge
                        as={Link}
                        to={getRoutePath("overview")}
                        variant="attention"
                        size="large"
                        leadingVisual={WrenchRegular}
                        className="mr-2 h-7 gap-[6px] pr-3 pl-[6px] text-[14px] leading-[21px] font-normal [--badge-visual-size:18px]"
                    >
                        Maintenance
                    </Badge>
                </Tooltip>
            )}

            <ThemeControl />
        </header>
    );
};
