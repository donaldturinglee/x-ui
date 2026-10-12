import { ConfigListTable } from "@/components/ConfigList";
import { keyOf } from "@/lib/rules";

import type { RuleSet } from "../api";

import { RuleSetRow } from "./RuleSetRow";

interface RuleSetsTableProps {
    labelledBy: string;
    ruleSets: RuleSet[];
    isLoading: boolean;
    hasError: boolean;
    disabled: boolean;
    onEdit: (index: number, anchor: HTMLButtonElement | null) => void;
    onDelete: (index: number, anchor: HTMLButtonElement | null) => void;
}

export const RuleSetsTable = ({
    labelledBy,
    ruleSets,
    isLoading,
    hasError,
    disabled,
    onEdit,
    onDelete,
}: RuleSetsTableProps) => (
    <ConfigListTable
        labelledBy={labelledBy}
        columns={["Tag", "Type", "Format", "Outbound", "Update", "Actions"]}
        isLoading={isLoading}
        isEmpty={ruleSets.length === 0}
        hasError={hasError}
        emptyMessage="No rule sets yet."
    >
        {ruleSets.map((ruleSet, index) => (
            <RuleSetRow
                key={keyOf(ruleSet)}
                ruleSet={ruleSet}
                disabled={disabled}
                onEdit={(anchor) => onEdit(index, anchor)}
                onDelete={(anchor) => onDelete(index, anchor)}
            />
        ))}
    </ConfigListTable>
);
