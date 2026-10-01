import { NavigationMenu, Text } from "@gamecrafters/base-ui/react";
import {
    AppFolderRegular,
    ChevronDownRegular,
    CloudArrowDownRegular,
    CloudArrowUpRegular,
    DirectionsRegular,
    GlobeSearchRegular,
    HomeRegular,
    PeopleRegular,
    PersonShieldRegular,
    SettingsRegular,
    type IconProps,
} from "@gamecrafters/base-ui-icons";
import { useId, type ComponentType } from "react";
import { NavLink, useLocation } from "react-router";

import { getRoutePath, type RouteKey } from "@/router/routes";
import { useSidebarStore } from "@/stores/sidebar";

interface NavigationItem {
    route: RouteKey;
    label: string;
    Icon: ComponentType<IconProps>;
}

// Pages that belong together under a heading of their own, which folds them
// away and brings them back.
interface NavigationGroup {
    label: string;
    Icon: ComponentType<IconProps>;
    items: NavigationItem[];
}

// The rail names the routes it leads to rather than their paths, so moving a
// page stays a change to the route table alone.
//
// The labels are the words the API and the configuration use -- inbounds,
// outbounds, clients -- rather than readings of them. An operator arrives here
// from the proxy core's own documentation, and a rail that called them
// something friendlier left them translating between the two.
//
// Traffic is followed down the list, in the reference's order: what arrives --
// what it is encrypted with among it, since a listener carries its own TLS --
// who it belongs to, where it goes out -- the tunnels it can go through among
// it -- which way traffic is sent and how the names it is sent to are resolved.
// General at the foot holds the operators and settings for the panel and node:
// subscriptions, two-factor authentication, the Telegram bot, NTP, HTTP clients
// and the configuration a node fetches. Backups are taken from the overview,
// where the reference keeps them, and the node's configuration is edited a part
// at a time on the relevant pages and settings tabs.
// The audit log is reachable at /audit but not from here: it is read when
// something is being looked into rather than as part of the work.
const entries: (NavigationItem | NavigationGroup)[] = [
    { route: "overview", label: "Overview", Icon: HomeRegular },
    { route: "inbounds", label: "Inbounds", Icon: CloudArrowDownRegular },
    { route: "clients", label: "Clients", Icon: PeopleRegular },
    { route: "outbounds", label: "Outbounds", Icon: CloudArrowUpRegular },
    { route: "rules", label: "Rules", Icon: DirectionsRegular },
    { route: "dns", label: "DNS", Icon: GlobeSearchRegular },
    {
        label: "General",
        Icon: AppFolderRegular,
        items: [
            { route: "admins", label: "Admins", Icon: PersonShieldRegular },
            { route: "generalSettings", label: "Settings", Icon: SettingsRegular },
        ],
    },
];

const isGroup = (entry: NavigationItem | NavigationGroup): entry is NavigationGroup =>
    "items" in entry;

interface EntryProps {
    // Whether the labels are in view. A rail kept to its icons lines every icon
    // up in one column; one wide enough to read sets the pages of a group in
    // under its heading.
    isExpanded: boolean;
    isCurrent: (route: RouteKey) => boolean;
}

interface PageLinkProps extends EntryProps {
    item: NavigationItem;
    isInGroup?: boolean;
}

const PageLink = ({
    item: { route, label, Icon },
    isInGroup = false,
    isExpanded,
    isCurrent,
}: PageLinkProps) => {
    // Each row is only as wide as the rail it stands in, so a collapsed rail cuts
    // it down to its icon and the label is uncovered as the rail widens rather
    // than being drawn past its edge. It is stretched to that width itself, since
    // the design system only stretches a link standing straight in an item, and
    // the pages of a group stand in a list of their own.
    return (
        <NavigationMenu.Link
            as={NavLink}
            to={getRoutePath(route)}
            // NavLink matches by prefix and marks itself current on its own, so it
            // is held to the whole path, the way the check beside it is, and a page
            // added under another's path cannot have both rows claim to be open.
            end
            current={isCurrent(route)}
            className={`group flex h-10 w-full justify-start gap-8 overflow-hidden rounded-[4px] py-1 pe-2 transition-[padding] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] data-current:bg-[var(--control-transparent-background-color-selected)] ${isInGroup && isExpanded ? "ps-6" : "ps-2"}`}
        >
            {/* The label beside it is what is read, so the mark is passed over
                rather than announced a second time. */}
            <Icon
                aria-hidden
                focusable={false}
                size={24}
                className="shrink-0 text-[var(--foreground-color-muted)] group-data-current:text-[var(--foreground-color-default)]"
            />
            <Text className="min-w-0 truncate text-[13px] leading-4 font-medium">{label}</Text>
        </NavigationMenu.Link>
    );
};

interface PageGroupProps extends EntryProps {
    group: NavigationGroup;
}

// A heading that folds its pages away and brings them back, drawn as a row like
// the rest with the mark of which way it goes at its end. Folded over the page
// that is open, it is marked in that page's place, so the rail still says where
// the operator is.
const PageGroup = ({ group, isExpanded, isCurrent }: PageGroupProps) => {
    const listId = useId();
    const isFolded = useSidebarStore((state) => state.foldedGroups.includes(group.label));
    const toggleGroup = useSidebarStore((state) => state.toggleGroup);
    const holdsCurrent = group.items.some(({ route }) => isCurrent(route));
    const { Icon } = group;

    return (
        <NavigationMenu.Item value={group.label}>
            <NavigationMenu.Link
                as="button"
                type="button"
                aria-expanded={!isFolded}
                aria-controls={listId}
                closeOnClick={false}
                data-holds-current={isFolded && holdsCurrent ? "" : undefined}
                className="group h-10 justify-start gap-8 overflow-hidden rounded-[4px] px-2 py-1 data-holds-current:bg-[var(--control-transparent-background-color-selected)]"
                onClick={() => toggleGroup(group.label)}
            >
                <Icon
                    aria-hidden
                    focusable={false}
                    size={24}
                    className="shrink-0 text-[var(--foreground-color-muted)] group-data-holds-current:text-[var(--foreground-color-default)]"
                />
                <Text className="min-w-0 truncate text-[13px] leading-4 font-medium">
                    {group.label}
                </Text>
                <ChevronDownRegular
                    aria-hidden
                    focusable={false}
                    size={16}
                    className={`ms-auto shrink-0 text-[var(--foreground-color-muted)] transition-transform duration-200 ${isFolded ? "" : "rotate-180"}`}
                />
            </NavigationMenu.Link>

            {!isFolded && (
                <ul id={listId} className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                    {group.items.map((item) => (
                        <li key={item.route}>
                            <PageLink
                                item={item}
                                isInGroup
                                isExpanded={isExpanded}
                                isCurrent={isCurrent}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </NavigationMenu.Item>
    );
};

interface SidebarNavigationProps {
    // Whether the rail or drawer it stands in is wide enough for the labels.
    isExpanded: boolean;
}

export const SidebarNavigation = ({ isExpanded }: SidebarNavigationProps) => {
    const { pathname } = useLocation();

    // Which page is open is settled against the router rather than left to the
    // link's own active state, so the rail and the router cannot disagree.
    const isCurrent = (route: RouteKey) => pathname === getRoutePath(route);

    return (
        <NavigationMenu orientation="vertical" aria-label="Panel">
            <NavigationMenu.List className="p-2">
                {entries.map((entry) =>
                    isGroup(entry) ? (
                        <PageGroup
                            key={entry.label}
                            group={entry}
                            isExpanded={isExpanded}
                            isCurrent={isCurrent}
                        />
                    ) : (
                        <NavigationMenu.Item key={entry.route} value={entry.route}>
                            <PageLink item={entry} isExpanded={isExpanded} isCurrent={isCurrent} />
                        </NavigationMenu.Item>
                    ),
                )}
            </NavigationMenu.List>
        </NavigationMenu>
    );
};
