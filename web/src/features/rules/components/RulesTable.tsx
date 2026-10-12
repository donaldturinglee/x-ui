import { useState } from "react";

import { ConfigListTable } from "@/components/ConfigList";
import { keyOf } from "@/lib/rules";

import type { RouteRule } from "../api";

import { RuleRow } from "./RuleRow";

interface RulesTableProps {
    labelledBy: string;
    rules: RouteRule[];
    outboundTags: string[];
    isLoading: boolean;
    hasError: boolean;
    disabled: boolean;
    onEdit: (index: number, anchor: HTMLButtonElement | null) => void;
    onDelete: (index: number, anchor: HTMLButtonElement | null) => void;
    onMove: (from: number, to: number) => void;
}

export const RulesTable = ({
    labelledBy,
    rules,
    outboundTags,
    isLoading,
    hasError,
    disabled,
    onEdit,
    onDelete,
    onMove,
}: RulesTableProps) => {
    const [dragged, setDragged] = useState<number | null>(null);
    const [dropTarget, setDropTarget] = useState<number | null>(null);

    const endDrag = () => {
        setDragged(null);
        setDropTarget(null);
    };

    return (
        <ConfigListTable
            labelledBy={labelledBy}
            columns={["Order", "Type", "Action", "Outbound", "Conditions", "Invert", "Actions"]}
            isLoading={isLoading}
            isEmpty={rules.length === 0}
            hasError={hasError}
            emptyMessage="No rules yet."
        >
            {rules.map((rule, index) => (
                <RuleRow
                    key={keyOf(rule)}
                    rule={rule}
                    position={index}
                    total={rules.length}
                    outboundTags={outboundTags}
                    disabled={disabled}
                    isDragged={dragged === index}
                    isDropTarget={dropTarget === index && dragged !== index}
                    onEdit={(anchor) => onEdit(index, anchor)}
                    onDelete={(anchor) => onDelete(index, anchor)}
                    onMove={(to) => onMove(index, to)}
                    onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", String(index));
                        setDragged(index);
                    }}
                    onDragEnd={endDrag}
                    onDragOver={(event) => {
                        if (dragged !== null && !disabled) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setDropTarget(index);
                        }
                    }}
                    onDrop={(event) => {
                        if (dragged !== null && !disabled) {
                            event.preventDefault();
                            onMove(dragged, index);
                        }
                        endDrag();
                    }}
                />
            ))}
        </ConfigListTable>
    );
};
