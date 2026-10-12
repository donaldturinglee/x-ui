import {
    ActionList,
    ActionMenu,
    Badge,
    Dialog,
    IconButton,
    Tooltip,
} from "@gamecrafters/base-ui/react";
import {
    DataTrendingRegular,
    DeleteRegular,
    DismissCircleRegular,
    EditRegular,
    MoreHorizontalRegular,
    TopSpeedRegular,
} from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { destination, refusesAll, tlsState, WIREGUARD, type Outbound } from "../api";
import type { OutboundCheckState } from "../api/useOutboundChecks";

interface OutboundRowProps {
    outbound: Outbound;
    isOnline: boolean;
    onEdit: () => void;
    onDelete: (anchor: HTMLButtonElement | null) => void;
    onTraffic: () => void;
    check?: OutboundCheckState;
    checkDisabled?: boolean;
    onCheck: () => void;
}

// A full value is available to a pointer, keyboard or touch user even when the
// column has to truncate it. The detail dialog also handles long IPv6 addresses.
const TruncatedValue = ({ text, label }: { text: string; label: string }) => {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [isOpen, setIsOpen] = useState(false);
    return (
        <>
            <Tooltip ref={buttonRef} type="description" text={text}>
                <button
                    type="button"
                    className="block max-w-full cursor-pointer truncate text-start"
                    onClick={() => setIsOpen(true)}
                >
                    {text}
                </button>
            </Tooltip>
            {isOpen && (
                <Dialog
                    title={label}
                    width={420}
                    onClose={() => setIsOpen(false)}
                    returnFocusRef={buttonRef}
                    footerButtons={[{ content: "Close", onClick: () => setIsOpen(false) }]}
                >
                    <p className="p-4 break-all">{text}</p>
                </Dialog>
            )}
        </>
    );
};

export const OutboundRow = ({
    outbound,
    isOnline,
    onEdit,
    onDelete,
    onTraffic,
    check,
    checkDisabled,
    onCheck,
}: OutboundRowProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const failureButtonRef = useRef<HTMLButtonElement>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const { server, port } = destination(outbound);
    const tls = tlsState(outbound);
    const isBlock = refusesAll(outbound.type);
    const cellClass = "px-3 py-2 text-start align-middle max-[839px]:min-w-0 max-[839px]:p-0";

    return (
        <tr className="h-14 border-b border-[var(--border-color-default)] last:border-b-0 max-[839px]:grid max-[839px]:h-auto max-[839px]:grid-cols-[minmax(0,1fr)_auto] max-[839px]:items-center max-[839px]:gap-x-3 max-[839px]:gap-y-2 max-[839px]:p-3">
            <td
                data-column="Tag"
                className={`${cellClass} max-[839px]:col-start-1 max-[839px]:row-start-1`}
            >
                <div className="max-w-[180px] font-medium max-[839px]:max-w-full">
                    <TruncatedValue text={outbound.tag} label="Tag" />
                </div>
            </td>
            <td
                data-column="Type"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-2 max-[839px]:row-start-1 max-[839px]:text-end max-[839px]:text-[var(--foreground-color-muted)]`}
            >
                {outbound.type === WIREGUARD ? "WireGuard" : outbound.type}
            </td>
            <td
                data-column="Address"
                className={`${cellClass} max-[839px]:col-start-1 max-[839px]:row-start-2`}
            >
                <div className="max-w-[224px] max-[839px]:max-w-full">
                    {server ? <TruncatedValue text={server} label="Address" /> : "—"}
                </div>
            </td>
            <td
                data-column="Port"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-2 max-[839px]:row-start-2 max-[839px]:text-end`}
            >
                <span
                    aria-hidden
                    className="me-1 hidden text-[var(--foreground-color-muted)] max-[839px]:inline"
                >
                    Port
                </span>
                {port ?? "—"}
            </td>
            <td
                data-column="TLS"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-1 max-[839px]:row-start-3`}
            >
                <span
                    aria-hidden
                    className="me-2 hidden text-[var(--foreground-color-muted)] max-[839px]:inline"
                >
                    TLS
                </span>
                {tls === "enabled" ? "Enabled" : tls === "disabled" ? "Disabled" : "—"}
            </td>
            <td
                data-column="Online"
                className={`${cellClass} max-[839px]:col-start-2 max-[839px]:row-start-3 max-[839px]:text-end`}
            >
                {isOnline ? (
                    <Badge variant="success" className="h-[22px] px-2.5">
                        Online
                    </Badge>
                ) : (
                    <>
                        <span
                            aria-hidden
                            className="me-1 hidden text-[var(--foreground-color-muted)] max-[839px]:inline"
                        >
                            Online
                        </span>
                        —
                    </>
                )}
            </td>
            <td
                data-column="Delay"
                className={`${cellClass} max-[839px]:col-start-1 max-[839px]:row-start-4`}
            >
                <div className="flex items-center gap-2" aria-live="polite">
                    <span
                        aria-hidden
                        className="hidden text-[var(--foreground-color-muted)] max-[839px]:inline"
                    >
                        Delay
                    </span>
                    {isBlock ? (
                        <Tooltip
                            type="description"
                            text="Block outbounds do not accept connections."
                        >
                            <Badge
                                as="button"
                                type="button"
                                variant="invisible"
                                className="h-[22px] px-0"
                            >
                                N/A
                            </Badge>
                        </Tooltip>
                    ) : check?.loading ? (
                        <span className="text-[var(--foreground-color-muted)]">Checking</span>
                    ) : check?.result?.ok ? (
                        <Badge variant="success" className="h-[22px] px-2 whitespace-nowrap">
                            {check.result.delay} ms
                        </Badge>
                    ) : check?.result ? (
                        <Tooltip
                            ref={failureButtonRef}
                            type="description"
                            text={check.result.error || "Connection check failed."}
                        >
                            <Badge
                                as="button"
                                type="button"
                                variant="danger"
                                leadingVisual={<DismissCircleRegular size={14} />}
                                aria-label={`Check failed for ${outbound.tag}`}
                                className="h-[22px] gap-1 px-2"
                                onClick={() =>
                                    setFailure(check.result?.error || "Connection check failed.")
                                }
                            >
                                Failed
                            </Badge>
                        </Tooltip>
                    ) : (
                        "—"
                    )}
                </div>
            </td>
            <td
                data-column="Actions"
                className={`${cellClass} max-[839px]:col-start-2 max-[839px]:row-start-4`}
            >
                <div className="flex items-center gap-1 max-[839px]:justify-end">
                    {!isBlock && (
                        <Tooltip type="description" text="Check connectivity through this outbound">
                            <IconButton
                                icon={<TopSpeedRegular size={20} />}
                                aria-label={`Check ${outbound.tag}`}
                                loading={check?.loading}
                                loadingAnnouncement={`Checking ${outbound.tag}`}
                                disabled={checkDisabled || check?.loading}
                                variant="invisible"
                                className="size-8 rounded-full"
                                onClick={onCheck}
                            />
                        </Tooltip>
                    )}
                    <div className="flex items-center gap-1 max-[839px]:hidden">
                        <Tooltip type="description" text="Edit">
                            <IconButton
                                icon={<EditRegular size={20} />}
                                aria-label={`Edit ${outbound.tag}`}
                                variant="invisible"
                                className="size-8 rounded-full"
                                onClick={onEdit}
                            />
                        </Tooltip>
                        <Tooltip ref={deleteButtonRef} type="description" text="Delete">
                            <IconButton
                                icon={<DeleteRegular size={20} />}
                                aria-label={`Delete ${outbound.tag}`}
                                variant="invisible"
                                className="size-8 rounded-full text-[var(--foreground-color-danger)]"
                                onClick={() => onDelete(deleteButtonRef.current)}
                            />
                        </Tooltip>
                        <Tooltip type="description" text="Traffic chart">
                            <IconButton
                                icon={<DataTrendingRegular size={20} />}
                                aria-label={`Traffic for ${outbound.tag}`}
                                variant="invisible"
                                className="size-8 rounded-full"
                                onClick={onTraffic}
                            />
                        </Tooltip>
                    </div>
                    <div className="hidden max-[839px]:block">
                        <ActionMenu anchorRef={menuButtonRef}>
                            <ActionMenu.Anchor>
                                <IconButton
                                    ref={menuButtonRef}
                                    icon={<MoreHorizontalRegular size={20} />}
                                    aria-label={`More actions for ${outbound.tag}`}
                                    variant="invisible"
                                    className="size-8 rounded-full"
                                />
                            </ActionMenu.Anchor>
                            <ActionMenu.Overlay align="end">
                                <ActionList>
                                    <ActionList.Item onSelect={onEdit}>
                                        <ActionList.LeadingVisual>
                                            <EditRegular />
                                        </ActionList.LeadingVisual>
                                        Edit
                                    </ActionList.Item>
                                    <ActionList.Item onSelect={onTraffic}>
                                        <ActionList.LeadingVisual>
                                            <DataTrendingRegular />
                                        </ActionList.LeadingVisual>
                                        Traffic chart
                                    </ActionList.Item>
                                    <ActionList.Item
                                        variant="danger"
                                        onSelect={() => onDelete(menuButtonRef.current)}
                                    >
                                        <ActionList.LeadingVisual>
                                            <DeleteRegular />
                                        </ActionList.LeadingVisual>
                                        Delete
                                    </ActionList.Item>
                                </ActionList>
                            </ActionMenu.Overlay>
                        </ActionMenu>
                    </div>
                </div>
                {failure !== null && (
                    <Dialog
                        title="Connection check failed"
                        subtitle={outbound.tag}
                        width={440}
                        onClose={() => setFailure(null)}
                        returnFocusRef={failureButtonRef}
                        footerButtons={[{ content: "Close", onClick: () => setFailure(null) }]}
                    >
                        <p className="p-4 break-words">{failure}</p>
                    </Dialog>
                )}
            </td>
        </tr>
    );
};
