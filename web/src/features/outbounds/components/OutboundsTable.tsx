import {
    Button,
    InlineMessage,
    NativeSelect,
    SkeletonText,
    Stack,
} from "@gamecrafters/base-ui/react";
import { ArrowUpRegular, TopSpeedRegular } from "@gamecrafters/base-ui-icons";
import { useId, useRef, useState } from "react";

import { AddButton } from "@/components/AddButton";
import { useGeneratedConfig } from "@/features/config/api";
import { TrafficDialog } from "@/features/diagnostics/components/TrafficDialog";
import { useOnlines } from "@/features/overview/api";

import { refusesAll, useOutbounds, type Outbound } from "../api";
import { useOutboundChecks } from "../api/useOutboundChecks";

import { CreateOutboundDialog } from "./CreateOutboundDialog";
import { DeleteOutboundDialog } from "./DeleteOutboundDialog";
import { EditOutboundDialog } from "./EditOutboundDialog";
import { OutboundRow } from "./OutboundRow";
import {
    nextOutboundSort,
    sortOutbounds,
    type OutboundSort,
    type OutboundSortKey,
} from "./sorting";

const COLUMNS: { title: string; key?: OutboundSortKey }[] = [
    { title: "Tag", key: "tag" },
    { title: "Type", key: "type" },
    { title: "Address" },
    { title: "Port" },
    { title: "TLS" },
    { title: "Online" },
    { title: "Delay", key: "delay" },
    { title: "Actions" },
];

const SORT_OPTIONS: { value: string; label: string; sort: OutboundSort | null }[] = [
    { value: "", label: "Original order", sort: null },
    { value: "tag:ascending", label: "Tag: A to Z", sort: { key: "tag", direction: "ascending" } },
    {
        value: "tag:descending",
        label: "Tag: Z to A",
        sort: { key: "tag", direction: "descending" },
    },
    {
        value: "type:ascending",
        label: "Type: A to Z",
        sort: { key: "type", direction: "ascending" },
    },
    {
        value: "type:descending",
        label: "Type: Z to A",
        sort: { key: "type", direction: "descending" },
    },
    {
        value: "delay:ascending",
        label: "Delay: fastest first",
        sort: { key: "delay", direction: "ascending" },
    },
    {
        value: "delay:descending",
        label: "Delay: slowest first",
        sort: { key: "delay", direction: "descending" },
    },
];

export const OutboundsTable = () => {
    const sortId = useId();
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const deleteReturnFocusRef = useRef<HTMLButtonElement>(null);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editing, setEditing] = useState<Outbound | null>(null);
    const [deleting, setDeleting] = useState<Outbound | null>(null);
    const [showingTraffic, setShowingTraffic] = useState<Outbound | null>(null);
    const [sort, setSort] = useState<OutboundSort | null>(null);
    const [batchOrder, setBatchOrder] = useState<number[]>([]);
    const { data: outbounds, error, isLoading } = useOutbounds();
    const { data: config } = useGeneratedConfig();
    const { data: onlines } = useOnlines();
    const checks = useOutboundChecks(outbounds, config);
    const isTesting = checks.batch?.running ?? false;
    const canTest = outbounds?.some((outbound) => !refusesAll(outbound.type)) ?? false;
    const sorted = sortOutbounds(outbounds ?? [], sort, checks.results);
    const batchRanks = new Map(batchOrder.map((id, index) => [id, index]));
    const rows = isTesting
        ? [...sorted].sort(
              (a, b) => (batchRanks.get(a.id) ?? Infinity) - (batchRanks.get(b.id) ?? Infinity),
          )
        : sorted;

    // Freeze the visible order for the whole batch. New results still appear
    // immediately in their row; delay sorting resumes once the batch finishes.
    const testAll = () => {
        if (isTesting) return;
        setBatchOrder(rows.map((outbound) => outbound.id));
        void checks.testAll();
    };

    const closeDelete = () => {
        if (!deleteReturnFocusRef.current?.isConnected) {
            deleteReturnFocusRef.current = addButtonRef.current;
        }
        setDeleting(null);
    };

    return (
        <>
            <Stack gap="condensed">
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <AddButton
                        ref={addButtonRef}
                        label="Add Outbound"
                        onClick={() => setIsCreateOpen(true)}
                    />
                    <Button
                        leadingVisual={<TopSpeedRegular size={20} />}
                        loading={isTesting}
                        disabled={!canTest || isTesting}
                        className="h-9 rounded-[4px] px-4 text-[14px]"
                        onClick={testAll}
                    >
                        Test all
                    </Button>
                    {checks.batch && (
                        <span role="status" className="text-sm">
                            {checks.batch.completed}/{checks.batch.total} checked
                        </span>
                    )}
                </div>
                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}
                <div className="overflow-hidden rounded-[4px] bg-[var(--background-color-default)] shadow-[var(--shadow-resting-medium)]">
                    <div className="hidden border-b border-[var(--border-color-default)] p-3 max-[839px]:block">
                        <label htmlFor={sortId} className="sr-only">
                            Sort by
                        </label>
                        <NativeSelect
                            id={sortId}
                            block
                            disabled={isTesting}
                            value={sort ? `${sort.key}:${sort.direction}` : ""}
                            onChange={(event) =>
                                setSort(
                                    SORT_OPTIONS.find(
                                        (option) => option.value === event.target.value,
                                    )?.sort ?? null,
                                )
                            }
                        >
                            {SORT_OPTIONS.map((option) => (
                                <NativeSelect.Option key={option.value} value={option.value}>
                                    {option.label}
                                </NativeSelect.Option>
                            ))}
                        </NativeSelect>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[980px] border-collapse text-start text-[14px] leading-[21px] max-[839px]:block max-[839px]:min-w-0">
                            <caption className="sr-only">Routes out</caption>
                            <thead className="max-[839px]:hidden">
                                <tr>
                                    {COLUMNS.map(({ title, key }) => (
                                        <th
                                            key={title}
                                            scope="col"
                                            aria-sort={
                                                key && sort?.key === key
                                                    ? sort.direction
                                                    : undefined
                                            }
                                            className="h-14 border-b border-[var(--border-color-default)] px-3 text-start font-medium whitespace-nowrap"
                                        >
                                            {key ? (
                                                <button
                                                    type="button"
                                                    aria-label={`Sort by ${title}`}
                                                    disabled={isTesting}
                                                    className="group inline-flex cursor-pointer items-center gap-1 disabled:cursor-default disabled:opacity-60"
                                                    onClick={() =>
                                                        setSort(nextOutboundSort(sort, key))
                                                    }
                                                >
                                                    {title}
                                                    <ArrowUpRegular
                                                        aria-hidden
                                                        size={16}
                                                        className={`transition-[opacity,rotate] ${sort?.key === key ? "opacity-100" : "opacity-0 group-hover:opacity-50"} ${sort?.key === key && sort.direction === "descending" ? "rotate-180" : ""}`}
                                                    />
                                                </button>
                                            ) : (
                                                title
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="max-[839px]:block">
                                {isLoading && (
                                    <tr>
                                        <td
                                            colSpan={COLUMNS.length}
                                            className="p-4 max-[839px]:block"
                                        >
                                            <SkeletonText lines={3} />
                                        </td>
                                    </tr>
                                )}
                                {!isLoading && !error && rows.length === 0 && (
                                    <tr>
                                        <td
                                            colSpan={COLUMNS.length}
                                            className="p-4 text-[var(--foreground-color-muted)] max-[839px]:block"
                                        >
                                            No outbounds yet.
                                        </td>
                                    </tr>
                                )}
                                {rows.map((outbound) => (
                                    <OutboundRow
                                        key={outbound.id}
                                        outbound={outbound}
                                        isOnline={(onlines?.outbound ?? []).includes(outbound.tag)}
                                        onEdit={() => setEditing(outbound)}
                                        onDelete={(anchor) => {
                                            deleteReturnFocusRef.current = anchor;
                                            setDeleting(outbound);
                                        }}
                                        onTraffic={() => setShowingTraffic(outbound)}
                                        check={checks.results[outbound.id]}
                                        checkDisabled={isTesting}
                                        onCheck={() => void checks.check(outbound)}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </Stack>
            {isCreateOpen && (
                <CreateOutboundDialog
                    onClose={() => setIsCreateOpen(false)}
                    returnFocusRef={addButtonRef}
                />
            )}
            {editing && (
                <EditOutboundDialog
                    outbound={editing}
                    onClose={() => setEditing(null)}
                    returnFocusRef={addButtonRef}
                />
            )}
            {deleting && (
                <DeleteOutboundDialog
                    outbound={deleting}
                    isLast={(outbounds?.length ?? 0) <= 1}
                    onClose={closeDelete}
                    onDeleted={() => {
                        deleteReturnFocusRef.current = addButtonRef.current;
                        setDeleting(null);
                    }}
                    returnFocusRef={deleteReturnFocusRef}
                />
            )}
            {showingTraffic && (
                <TrafficDialog
                    resource="outbound"
                    tag={showingTraffic.tag}
                    onClose={() => setShowingTraffic(null)}
                    returnFocusRef={addButtonRef}
                />
            )}
        </>
    );
};
