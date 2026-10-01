import { Button, IconButton, Tooltip } from "@gamecrafters/base-ui/react";
import {
    ArrowUpRegular,
    DocumentDismissRegular,
    DocumentEditRegular,
} from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { httpVersionName, type HttpClient } from "../api";

import { HttpClientDialog } from "./HttpClientDialog";

interface HttpClientsProps {
    clients: HttpClient[];
    outboundTags: string[];
    // Held back until the document has been read.
    disabled: boolean;
    onChange: (clients: HttpClient[]) => void;
}

type SortKey = "tag" | "version" | "engine" | "detour";

interface Sort {
    key: SortKey;
    direction: "ascending" | "descending";
}

// The columns as the reference lays them out, each of which orders the rows.
const COLUMNS: { title: string; key: SortKey }[] = [
    { title: "Tag", key: "tag" },
    { title: "HTTP version", key: "version" },
    { title: "Engine", key: "engine" },
    { title: "Detour", key: "detour" },
];

// What a client is ordered by in a column: a version by its number, with none
// as Auto, and an option left out before any that is set.
const sortValue = (client: HttpClient, key: SortKey) =>
    key === "version"
        ? typeof client.version === "number"
            ? client.version
            : 0
        : typeof client[key] === "string"
          ? client[key]
          : "";

// Tags are compared the way a person reads them, so dl-10 comes after dl-9.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// A header pressed once orders its column up, twice down, and a third time
// leaves the clients in the document's order, the way the reference's do.
const nextSort = (sort: Sort | null, key: SortKey): Sort | null => {
    if (sort?.key !== key) {
        return { key, direction: "ascending" };
    }

    return sort.direction === "ascending" ? { key, direction: "descending" } : null;
};

// The reference's compact table: a header row of 40 pixels, its line inside
// them, over rows of 36 with a line between each.
const HEAD =
    "h-10 border-b border-[var(--border-color-default)] px-4 text-start font-medium whitespace-nowrap";
const CELL = "h-9 px-4 align-middle";

// The shared HTTP clients as the reference lists them: a button that adds one
// over a compact table of what there is. Taking one away changes the page and
// nothing else until it is saved, so it is done on the press, as the reference
// does it, rather than asked about first.
//
// Ordering the rows only changes how they are shown: the document keeps its
// clients in the order they were added.
export const HttpClients = ({ clients, outboundTags, disabled, onChange }: HttpClientsProps) => {
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const [editing, setEditing] = useState<{ index: number | null } | null>(null);
    const [sort, setSort] = useState<Sort | null>(null);

    // Each row keeps where its client is in the document, which is what an
    // edit or a removal is made at.
    const rows = clients.map((client, index) => ({ client, index }));

    if (sort) {
        const sign = sort.direction === "ascending" ? 1 : -1;

        rows.sort((a, b) => {
            const left = sortValue(a.client, sort.key);
            const right = sortValue(b.client, sort.key);

            return (
                sign *
                (typeof left === "string" && typeof right === "string"
                    ? collator.compare(left, right)
                    : Number(left) - Number(right))
            );
        });
    }

    const save = (client: HttpClient) => {
        const index = editing?.index ?? null;

        onChange(
            index === null
                ? [...clients, client]
                : clients.map((current, position) => (position === index ? client : current)),
        );
        setEditing(null);
    };

    const remove = (index: number) => {
        onChange(clients.filter((_, position) => position !== index));
        addButtonRef.current?.focus();
    };

    return (
        <>
            {/* Tinted rather than filled, the way the reference draws a button that
                works inside a panel rather than on the page. */}
            <Button
                ref={addButtonRef}
                aria-label="Add HTTP client"
                disabled={disabled}
                className="mb-0 h-9 min-w-16 rounded-[4px] border-0 bg-[var(--background-color-accent-muted)] px-4 text-[14px] text-[var(--foreground-color-accent)]"
                onClick={() => setEditing({ index: null })}
            >
                Add
            </Button>

            <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-[14px] leading-[21px]">
                    <caption className="sr-only">HTTP clients</caption>
                    <thead>
                        <tr>
                            {COLUMNS.map(({ title, key }) => (
                                <th
                                    key={key}
                                    scope="col"
                                    aria-sort={sort?.key === key ? sort.direction : undefined}
                                    className={HEAD}
                                >
                                    <button
                                        type="button"
                                        className="group/sort inline-flex cursor-pointer items-center gap-1 font-medium"
                                        onClick={() => setSort(nextSort(sort, key))}
                                    >
                                        {title}
                                        {/* Faint on the column the pointer is on, so a
                                            header reads as something to press, and
                                            plain on the one the rows are ordered by.
                                            The group is named, since the panel the
                                            table sits in is a group of its own. */}
                                        <ArrowUpRegular
                                            aria-hidden
                                            size={16}
                                            className={`transition-[opacity,rotate] ${
                                                sort?.key === key
                                                    ? "opacity-100"
                                                    : "opacity-0 group-hover/sort:opacity-50"
                                            } ${
                                                sort?.key === key && sort.direction === "descending"
                                                    ? "rotate-180"
                                                    : ""
                                            }`}
                                        />
                                    </button>
                                </th>
                            ))}
                            <th scope="col" className={HEAD}>
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 ? (
                            <tr>
                                <td colSpan={COLUMNS.length + 1} className={`${CELL} text-center`}>
                                    No HTTP client defined
                                </td>
                            </tr>
                        ) : (
                            rows.map(({ client, index }) => (
                                <tr
                                    key={`${client.tag}-${index}`}
                                    className="[&:not(:last-child)>*]:border-b [&>*]:border-[var(--border-color-default)]"
                                >
                                    <th scope="row" className={`${CELL} text-start font-normal`}>
                                        {client.tag}
                                    </th>
                                    <td className={CELL}>{httpVersionName(client.version)}</td>
                                    <td className={CELL}>
                                        {typeof client.engine === "string" ? client.engine : "—"}
                                    </td>
                                    <td className={CELL}>
                                        {typeof client.detour === "string" ? client.detour : "—"}
                                    </td>
                                    <td className={`${CELL} text-end whitespace-nowrap`}>
                                        <Tooltip text="Edit" direction="n">
                                            <IconButton
                                                icon={<DocumentEditRegular size={20} />}
                                                aria-label={`Edit ${client.tag}`}
                                                variant="invisible"
                                                className="size-7 rounded-full"
                                                onClick={() => setEditing({ index })}
                                            />
                                        </Tooltip>
                                        <Tooltip text="Delete" direction="n">
                                            <IconButton
                                                icon={<DocumentDismissRegular size={20} />}
                                                aria-label={`Delete ${client.tag}`}
                                                variant="invisible"
                                                className="size-7 rounded-full text-[var(--foreground-color-attention)]"
                                                onClick={() => remove(index)}
                                            />
                                        </Tooltip>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {editing && (
                <HttpClientDialog
                    client={editing.index === null ? undefined : clients[editing.index]}
                    takenTags={clients.map((client) => client.tag)}
                    outboundTags={outboundTags}
                    onSave={save}
                    onClose={() => setEditing(null)}
                    returnFocusRef={addButtonRef}
                />
            )}
        </>
    );
};
