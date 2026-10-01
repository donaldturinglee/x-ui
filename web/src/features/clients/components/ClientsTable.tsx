import {
    ActionList,
    ActionMenu,
    IconButton,
    InlineMessage,
    NativeSelect,
    SkeletonText,
    Stack,
} from "@gamecrafters/base-ui/react";
import {
    ArrowNextRegular,
    ArrowPreviousRegular,
    ArrowResetRegular,
    ArrowUpRegular,
    ChevronLeftRegular,
    ChevronRightRegular,
    WrenchScrewdriverRegular,
} from "@gamecrafters/base-ui-icons";
import { useId, useRef, useState } from "react";

import { AddButton } from "@/components/AddButton";
import { TrafficDialog } from "@/features/diagnostics/components/TrafficDialog";
import { useInbounds } from "@/features/inbounds/api";
import { useOnlines } from "@/features/overview/api";
import { useNow } from "@/lib/clock";

import {
    CLIENTS_PER_PAGE,
    PAGE_SIZES,
    emptyFilter,
    useClients,
    useSetClientEnabled,
    type Client,
    type ClientFilter,
} from "../api";

import { ClientLinksDialog } from "./ClientLinksDialog";
import { ClientRow } from "./ClientRow";
import { CreateClientDialog } from "./CreateClientDialog";
import { EditClientDialog } from "./EditClientDialog";
import { FilterMenu } from "./FilterMenu";
import { ResetAllTrafficDialog } from "./ResetAllTrafficDialog";

// What a column can be ordered by. The order is the page's own rather than the
// API's, which lists subscribers in the order they were added.
type SortKey =
    | "name"
    | "enable"
    | "desc"
    | "group"
    | "inbounds"
    | "volume"
    | "expiry"
    | "createdAt"
    | "onlineAt";

interface Sort {
    key: SortKey;
    direction: "ascending" | "descending";
}

// The columns as the reference lays them out, in its order. What can be done to a
// subscriber and whether they are online are not values to order the rows by.
const COLUMNS: { title: string; key?: SortKey }[] = [
    { title: "Name", key: "name" },
    { title: "Enable", key: "enable" },
    { title: "Description", key: "desc" },
    { title: "Group", key: "group" },
    { title: "Inbounds", key: "inbounds" },
    { title: "Action" },
    { title: "Volume", key: "volume" },
    { title: "Expiry", key: "expiry" },
    { title: "Online" },
    { title: "Created", key: "createdAt" },
    { title: "Last online", key: "onlineAt" },
];

const sortValue = (client: Client, key: SortKey) => {
    switch (key) {
        case "enable":
            return Number(client.enable);
        case "inbounds":
            return client.inbounds?.length ?? 0;
        default:
            return client[key];
    }
};

// Names are compared the way a person reads them, so user-10 comes after user-9.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const sorted = (clients: Client[], sort: Sort | null) => {
    if (!sort) {
        return clients;
    }

    const sign = sort.direction === "ascending" ? 1 : -1;

    return [...clients].sort((a, b) => {
        const left = sortValue(a, sort.key);
        const right = sortValue(b, sort.key);

        return (
            sign *
            (typeof left === "string" && typeof right === "string"
                ? collator.compare(left, right)
                : Number(left) - Number(right))
        );
    });
};

// A header pressed once orders its column up, twice down, and a third time
// leaves the rows as the API listed them, the way the reference's headers do.
const nextSort = (sort: Sort | null, key: SortKey): Sort | null => {
    if (sort?.key !== key) {
        return { key, direction: "ascending" };
    }

    return sort.direction === "ascending" ? { key, direction: "descending" } : null;
};

// The subscribers as the reference lays them out: the button that adds one, the
// menu of what is done to all of them and the filter, centred over a table that
// is one line per subscriber on a wide screen and a column per subscriber on a
// narrow one, paged at its foot once there is more than a page.
export const ClientsTable = () => {
    const pageSizeId = useId();
    const sortById = useId();
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [isResetAllOpen, setIsResetAllOpen] = useState(false);
    const [editing, setEditing] = useState<Client | null>(null);
    const [showingLinks, setShowingLinks] = useState<Client | null>(null);
    const [showingTraffic, setShowingTraffic] = useState<Client | null>(null);
    const [toggling, setToggling] = useState<number[]>([]);
    const [filter, setFilter] = useState<ClientFilter>(emptyFilter);
    const [pageSize, setPageSize] = useState(CLIENTS_PER_PAGE);
    const [sort, setSort] = useState<Sort | null>(null);
    const { data, error, isLoading } = useClients(filter, pageSize);
    const { data: inbounds } = useInbounds();
    const { data: onlines } = useOnlines();
    const { trigger: setEnabled, error: toggleError } = useSetClientEnabled();
    const now = useNow();

    const total = data?.total ?? 0;
    const shown = data?.clients.length ?? 0;
    const lastOffset = Math.max(0, Math.ceil(total / pageSize) - 1) * pageSize;

    const tagsOf = (client: Client) =>
        (client.inbounds ?? []).map(
            (id) => inbounds?.find((inbound) => inbound.id === id)?.tag ?? `#${id}`,
        );

    const toggle = async (client: Client, enable: boolean) => {
        setToggling((ids) => [...ids, client.id]);
        await setEnabled({ id: client.id, enable });
        setToggling((ids) => ids.filter((id) => id !== client.id));
    };

    const goTo = (offset: number) => setFilter((current) => ({ ...current, offset }));

    // A dialog is mounted only while it is open, so what was typed into one is
    // gone by the time it is opened again rather than left half filled in.
    return (
        <>
            <Stack gap="condensed">
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <AddButton
                        ref={addButtonRef}
                        label="Add client"
                        onClick={() => setIsCreateOpen(true)}
                    />

                    {/* What is done to every subscriber at once. The reference
                        also adds and edits them in bulk from here; the API takes
                        subscribers one at a time, so those are left out rather
                        than made into a run of requests that can stop halfway. */}
                    <ActionMenu>
                        <ActionMenu.Anchor>
                            <IconButton
                                icon={<WrenchScrewdriverRegular size={24} />}
                                aria-label="Tools"
                                variant="invisible"
                                className="size-12 rounded-full text-[var(--foreground-color-accent)]"
                            />
                        </ActionMenu.Anchor>

                        <ActionMenu.Overlay align="center">
                            <ActionList>
                                <ActionList.Item onSelect={() => setIsResetAllOpen(true)}>
                                    <ActionList.LeadingVisual>
                                        <ArrowResetRegular />
                                    </ActionList.LeadingVisual>
                                    Reset all traffic
                                </ActionList.Item>
                            </ActionList>
                        </ActionMenu.Overlay>
                    </ActionMenu>

                    <FilterMenu filter={filter} onApply={setFilter} />
                </div>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

                {/* A switch is flipped without a dialog to say what the API made
                    of it in, so a refusal is said here, above the rows. */}
                {toggleError && (
                    <InlineMessage variant="critical">{toggleError.message}</InlineMessage>
                )}

                <div className="overflow-hidden rounded-[4px] bg-[var(--background-color-default)] shadow-[var(--shadow-resting-medium)]">
                    {/* Scrolled sideways rather than squeezed, once the columns no
                        longer fit across the page beside the rail. */}
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-start text-[14px] leading-[21px] max-[839px]:block">
                            <caption className="sr-only">Subscribers</caption>

                            <thead className="max-[839px]:block">
                                <tr className="max-[839px]:hidden">
                                    {COLUMNS.map(({ title, key }) => (
                                        <th
                                            key={title}
                                            scope="col"
                                            aria-sort={
                                                key && sort?.key === key
                                                    ? sort.direction
                                                    : undefined
                                            }
                                            className="h-14 border-b border-[var(--border-color-default)] px-4 text-start font-medium whitespace-nowrap"
                                        >
                                            {key ? (
                                                <button
                                                    type="button"
                                                    className="group inline-flex cursor-pointer items-center gap-1 font-medium"
                                                    onClick={() => setSort(nextSort(sort, key))}
                                                >
                                                    {title}
                                                    {/* Faint on the column the pointer is on,
                                                        so a header reads as something to
                                                        press, and plain on the one the rows
                                                        are ordered by. */}
                                                    <ArrowUpRegular
                                                        aria-hidden
                                                        size={16}
                                                        className={`transition-[opacity,rotate] ${
                                                            sort?.key === key
                                                                ? "opacity-100"
                                                                : "opacity-0 group-hover:opacity-50"
                                                        } ${
                                                            sort?.key === key &&
                                                            sort.direction === "descending"
                                                                ? "rotate-180"
                                                                : ""
                                                        }`}
                                                    />
                                                </button>
                                            ) : (
                                                title
                                            )}
                                        </th>
                                    ))}
                                </tr>

                                {/* Stacked, the rows have no header row to press,
                                    so what they are ordered by is chosen above
                                    them instead. */}
                                <tr className="hidden max-[839px]:block">
                                    <th className="block border-b border-[var(--border-color-default)] px-4 py-3 text-start font-normal">
                                        <label htmlFor={sortById} className="sr-only">
                                            Sort by
                                        </label>
                                        <NativeSelect
                                            id={sortById}
                                            block
                                            value={sort?.key ?? ""}
                                            onChange={(event) =>
                                                setSort(
                                                    event.target.value
                                                        ? {
                                                              key: event.target.value as SortKey,
                                                              direction: "ascending",
                                                          }
                                                        : null,
                                                )
                                            }
                                        >
                                            <NativeSelect.Option value="">
                                                Sort by
                                            </NativeSelect.Option>
                                            {COLUMNS.filter((column) => column.key).map(
                                                ({ title, key }) => (
                                                    <NativeSelect.Option key={key} value={key!}>
                                                        {title}
                                                    </NativeSelect.Option>
                                                ),
                                            )}
                                        </NativeSelect>
                                    </th>
                                </tr>
                            </thead>

                            <tbody className="max-[839px]:block">
                                {/* A read that has not answered yet is shown as
                                    the table it is going to fill, so the rows
                                    arrive in place rather than after a spinner. */}
                                {isLoading && (
                                    <tr>
                                        <td colSpan={COLUMNS.length} className="p-4">
                                            <SkeletonText lines={3} />
                                        </td>
                                    </tr>
                                )}

                                {data &&
                                    sorted(data.clients, sort).map((client) => (
                                        <ClientRow
                                            key={client.id}
                                            client={client}
                                            inboundTags={tagsOf(client)}
                                            isOnline={(onlines?.client ?? []).includes(client.name)}
                                            isToggling={toggling.includes(client.id)}
                                            now={now}
                                            onToggle={(enable) => void toggle(client, enable)}
                                            onEdit={() => setEditing(client)}
                                            onLinks={() => setShowingLinks(client)}
                                            onTraffic={() => setShowingTraffic(client)}
                                        />
                                    ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Only once there is more than the smallest page, the way the
                        reference hides it; the count is then worth saying, because
                        "10 subscribers" and "10 of 400" are different situations to
                        be looking at. */}
                    {total > PAGE_SIZES[0] && (
                        <div className="flex flex-wrap items-center justify-end border-t border-[var(--border-color-default)] px-1 py-2">
                            <div className="flex items-center">
                                <label htmlFor={pageSizeId} className="pe-2 font-normal">
                                    Items per page:
                                </label>
                                {/* A different page size is a different first page,
                                    so changing it starts from the top. */}
                                <NativeSelect
                                    id={pageSizeId}
                                    size="large"
                                    value={String(pageSize)}
                                    onChange={(event) => {
                                        setPageSize(Number(event.target.value));
                                        goTo(0);
                                    }}
                                    className="w-[90px]"
                                >
                                    {PAGE_SIZES.map((size) => (
                                        <NativeSelect.Option key={size} value={String(size)}>
                                            {size}
                                        </NativeSelect.Option>
                                    ))}
                                </NativeSelect>
                            </div>

                            <span className="px-4">
                                {filter.offset + 1}-{filter.offset + shown} of {total}
                            </span>

                            <div className="flex items-center gap-[9.6px]">
                                <IconButton
                                    icon={<ArrowPreviousRegular size={24} />}
                                    aria-label="First page"
                                    variant="invisible"
                                    disabled={filter.offset === 0}
                                    className="size-9 rounded-full text-[var(--foreground-color-default)]"
                                    onClick={() => goTo(0)}
                                />
                                <IconButton
                                    icon={<ChevronLeftRegular size={24} />}
                                    aria-label="Previous page"
                                    variant="invisible"
                                    disabled={filter.offset === 0}
                                    className="size-9 rounded-full text-[var(--foreground-color-default)]"
                                    onClick={() => goTo(Math.max(0, filter.offset - pageSize))}
                                />
                                <IconButton
                                    icon={<ChevronRightRegular size={24} />}
                                    aria-label="Next page"
                                    variant="invisible"
                                    disabled={filter.offset + shown >= total}
                                    className="size-9 rounded-full text-[var(--foreground-color-default)]"
                                    onClick={() => goTo(filter.offset + pageSize)}
                                />
                                <IconButton
                                    icon={<ArrowNextRegular size={24} />}
                                    aria-label="Last page"
                                    variant="invisible"
                                    disabled={filter.offset + shown >= total}
                                    className="size-9 rounded-full text-[var(--foreground-color-default)]"
                                    onClick={() => goTo(lastOffset)}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </Stack>

            {isCreateOpen && (
                <CreateClientDialog
                    onClose={() => setIsCreateOpen(false)}
                    returnFocusRef={addButtonRef}
                />
            )}

            {isResetAllOpen && <ResetAllTrafficDialog onClose={() => setIsResetAllOpen(false)} />}

            {/* What any of these was opened from is a button in a row, and the
                row goes when the subscriber does, so focus is handed back to
                what opened the table rather than to something that may not be
                there. */}
            {editing && (
                <EditClientDialog
                    client={editing}
                    onClose={() => setEditing(null)}
                    returnFocusRef={addButtonRef}
                />
            )}

            {showingLinks && (
                <ClientLinksDialog
                    client={showingLinks}
                    onClose={() => setShowingLinks(null)}
                    returnFocusRef={addButtonRef}
                />
            )}

            {showingTraffic && (
                <TrafficDialog
                    resource="client"
                    tag={showingTraffic.name}
                    onClose={() => setShowingTraffic(null)}
                    returnFocusRef={addButtonRef}
                />
            )}
        </>
    );
};
