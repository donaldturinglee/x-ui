import { IconButton } from "@gamecrafters/base-ui/react";
import { ReOrderDotsVerticalRegular } from "@gamecrafters/base-ui-icons";
import type { DragEventHandler } from "react";

import { ConfigListActions, ConfigListValue } from "@/components/ConfigList";

import { ruleConditions, ruleKind, type RouteRule } from "../api";

interface RuleRowProps {
    rule: RouteRule;
    position: number;
    total: number;
    outboundTags: string[];
    disabled: boolean;
    isDragged: boolean;
    isDropTarget: boolean;
    onEdit: (anchor: HTMLButtonElement | null) => void;
    onDelete: (anchor: HTMLButtonElement | null) => void;
    onMove: (to: number) => void;
    onDragStart: DragEventHandler<HTMLButtonElement>;
    onDragEnd: DragEventHandler<HTMLButtonElement>;
    onDragOver: DragEventHandler<HTMLTableRowElement>;
    onDrop: DragEventHandler<HTMLTableRowElement>;
}

export const RuleRow = ({
    rule,
    position,
    total,
    outboundTags,
    disabled,
    isDragged,
    isDropTarget,
    onEdit,
    onDelete,
    onMove,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDrop,
}: RuleRowProps) => {
    const name = `rule ${position + 1}`;
    const outbound = typeof rule.outbound === "string" && rule.outbound ? rule.outbound : null;
    const count = ruleConditions(rule);
    const conditions =
        rule.type === "logical"
            ? `${count} subrule${count === 1 ? "" : "s"}`
            : `${count} condition${count === 1 ? "" : "s"}`;
    const cellClass = "px-3 py-2 text-start align-middle max-[839px]:min-w-0 max-[839px]:p-0";

    return (
        <tr
            onDragOver={onDragOver}
            onDrop={onDrop}
            className={`h-14 border-b border-[var(--border-color-default)] last:border-b-0 max-[839px]:grid max-[839px]:h-auto max-[839px]:grid-cols-[minmax(0,1fr)_auto] max-[839px]:items-center max-[839px]:gap-x-3 max-[839px]:gap-y-2 max-[839px]:p-3 ${isDragged ? "opacity-50" : ""} ${isDropTarget ? "bg-[var(--background-color-accent-muted)] outline-2 -outline-offset-2 outline-[var(--border-color-accent-emphasis)]" : ""}`}
        >
            <td
                data-column="Order"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-1 max-[839px]:row-start-1`}
            >
                <div className="flex items-center gap-1">
                    <IconButton
                        icon={<ReOrderDotsVerticalRegular size={20} />}
                        aria-label={`Drag ${name} to reorder`}
                        variant="invisible"
                        draggable={!disabled}
                        disabled={disabled}
                        className="size-8 cursor-grab rounded-full active:cursor-grabbing"
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                    />
                </div>
            </td>
            <td
                data-column="Type"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-2 max-[839px]:row-start-1 max-[839px]:text-end max-[839px]:text-[var(--foreground-color-muted)]`}
            >
                {ruleKind(rule)}
            </td>
            <td
                data-column="Action"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-1 max-[839px]:row-start-2`}
            >
                <span className="me-2 hidden text-[var(--foreground-color-muted)] max-[839px]:inline">
                    Action{" "}
                </span>
                {typeof rule.action === "string" ? rule.action : "route"}
            </td>
            <td
                data-column="Outbound"
                className={`${cellClass} max-[839px]:col-span-2 max-[839px]:row-start-3`}
            >
                <div className="flex items-center gap-2">
                    <span className="hidden shrink-0 text-[var(--foreground-color-muted)] max-[839px]:inline">
                        Outbound
                    </span>
                    <div className="max-w-[180px] min-w-0 max-[839px]:max-w-full">
                        {outbound === null ? (
                            "—"
                        ) : (
                            <div
                                className={
                                    outboundTags.includes(outbound)
                                        ? ""
                                        : "text-[var(--foreground-color-attention)]"
                                }
                            >
                                <ConfigListValue text={outbound} label={`Outbound for ${name}`} />
                                {!outboundTags.includes(outbound) && <span>missing</span>}
                            </div>
                        )}
                    </div>
                </div>
            </td>
            <td
                data-column="Conditions"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-1 max-[839px]:row-start-4`}
            >
                {conditions}
            </td>
            <td
                data-column="Invert"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-2 max-[839px]:row-start-4 max-[839px]:text-end`}
            >
                <span className="me-2 hidden text-[var(--foreground-color-muted)] max-[839px]:inline">
                    Invert{" "}
                </span>
                {rule.invert === true ? "Yes" : "No"}
            </td>
            <td
                data-column="Actions"
                className={`${cellClass} max-[839px]:col-start-2 max-[839px]:row-start-2`}
            >
                <ConfigListActions
                    name={name}
                    disabled={disabled}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    move={{
                        canMoveUp: position > 0,
                        canMoveDown: position < total - 1,
                        onMoveUp: () => onMove(position - 1),
                        onMoveDown: () => onMove(position + 1),
                    }}
                />
            </td>
        </tr>
    );
};
