import { Avatar, Drawer, IconButton, Separator, Text } from "@gamecrafters/base-ui/react";
import { DismissRegular } from "@gamecrafters/base-ui-icons";
import type { ReactNode } from "react";

import { SignoutButton } from "@/features/auth/components/SignoutButton";
import { settings } from "@/settings";
import { useSidebarStore } from "@/stores/sidebar";

import { SidebarNavigation } from "./SidebarNavigation";

interface NavigationDrawerProps {
    // Below the width the shell switches at, the rail gives way to a drawer that
    // is brought out over the page rather than standing beside it.
    isMobile: boolean;
    // Whether that drawer is out. A rail is always there, so it has no use for this.
    isOpen: boolean;
    onClose: () => void;
}

interface RailHeaderProps {
    isExpanded: boolean;
    // Stands at the end of the row, after the name.
    children?: ReactNode;
}

// The panel's name at the head of the rail. It is as tall as the app bar beside it
// less the line under it, so the two read as one band across the top of the page.
//
// The mark shrinks with the rail rather than being cut in half by it, and the name
// is left to be uncovered as the rail widens.
const RailHeader = ({ isExpanded, children }: RailHeaderProps) => {
    return (
        <div className="flex h-[63px] shrink-0 items-center gap-4 px-4 py-1">
            {/* The name beside it says the same thing, so the mark is not read out as
                well. */}
            <Avatar
                aria-hidden
                size={isExpanded ? 40 : 24}
                className="shrink-0 transition-[width,height] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]"
            >
                <Avatar.Fallback name={settings.app_title} />
            </Avatar>
            <Text className="min-w-0 flex-1 truncate text-[16px] leading-6 tracking-[0.5px]">
                {settings.app_title}
            </Text>
            {children}
        </div>
    );
};

// Where an operator moves between pages. On a wide screen it is a rail held
// against the left edge, expanded to its labels and collapsed back to its icons
// by the button at the head of the app bar, and by nothing else: neither the
// pointer passing over it nor the keyboard reaching it widens it, so it never
// lies over the page, and the page moves along only when it is asked to make
// room. Collapsed, each icon is still read out by the label it has cut off. On a
// narrow screen there is no room for even the icons, so it is a drawer the app
// bar brings out, laid over the page until a page is picked.
export const NavigationDrawer = ({ isMobile, isOpen, onClose }: NavigationDrawerProps) => {
    const isExpanded = useSidebarStore((state) => state.isExpanded);

    if (isMobile) {
        // The drawer holds the page still behind it and keeps focus inside it, the
        // way a dialog does, and takes itself away again on Escape or a click off it.
        // A page being picked takes it away as well, which the shell sees to.
        return isOpen ? (
            <Drawer
                position="left"
                size={256}
                aria-label={settings.app_title}
                onClose={onClose}
                className="rounded-none border-r border-[var(--border-color-default)] bg-[var(--background-color-default)]"
            >
                {/* The header draws the line under itself, so it is held off the
                    list by that line rather than laid over its first row. */}
                <Drawer.Header className="mb-px block p-0">
                    <RailHeader isExpanded>
                        <IconButton
                            icon={<DismissRegular size={24} />}
                            aria-label="Close"
                            variant="invisible"
                            className="size-6"
                            onClick={onClose}
                        />
                    </RailHeader>
                </Drawer.Header>

                <Drawer.Body className="p-0">
                    <SidebarNavigation isExpanded />
                </Drawer.Body>

                <Drawer.Footer className="block p-0">
                    <SignoutButton />
                </Drawer.Footer>
            </Drawer>
        ) : null;
    }

    return (
        <aside
            data-expanded={isExpanded ? "" : undefined}
            className="fixed inset-y-0 left-0 z-[var(--z-index-overlay)] flex w-14 flex-col overflow-hidden border-r border-[var(--border-color-default)] bg-[var(--background-color-default)] transition-[width] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] data-expanded:w-64"
        >
            {/* The name scrolls away with the list on a screen too short for both, and
                signing out stays pinned to the foot of the rail below them. */}
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                <RailHeader isExpanded={isExpanded} />
                <Separator />
                <SidebarNavigation isExpanded={isExpanded} />
            </div>

            <SignoutButton />
        </aside>
    );
};
