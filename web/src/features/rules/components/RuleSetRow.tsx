import { ConfigListActions, ConfigListValue } from "@/components/ConfigList";

import { downloadDetour, ruleSetTypeName, type RuleSet } from "../api";

interface RuleSetRowProps {
    ruleSet: RuleSet;
    disabled: boolean;
    onEdit: (anchor: HTMLButtonElement | null) => void;
    onDelete: (anchor: HTMLButtonElement | null) => void;
}

export const RuleSetRow = ({ ruleSet, disabled, onEdit, onDelete }: RuleSetRowProps) => {
    const outbound = downloadDetour(ruleSet);
    const interval =
        typeof ruleSet.update_interval === "string" && ruleSet.update_interval
            ? ruleSet.update_interval
            : "—";
    const cellClass = "px-3 py-2 text-start align-middle max-[839px]:min-w-0 max-[839px]:p-0";

    return (
        <tr className="h-14 border-b border-[var(--border-color-default)] last:border-b-0 max-[839px]:grid max-[839px]:h-auto max-[839px]:grid-cols-[minmax(0,1fr)_auto] max-[839px]:items-center max-[839px]:gap-x-3 max-[839px]:gap-y-2 max-[839px]:p-3">
            <td
                data-column="Tag"
                className={`${cellClass} max-[839px]:col-start-1 max-[839px]:row-start-1`}
            >
                <div className="max-w-[220px] font-medium max-[839px]:max-w-full">
                    <ConfigListValue text={ruleSet.tag} label="Rule set tag" />
                </div>
            </td>
            <td
                data-column="Type"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-2 max-[839px]:row-start-1 max-[839px]:text-end max-[839px]:text-[var(--foreground-color-muted)]`}
            >
                {ruleSetTypeName(ruleSet.type)}
            </td>
            <td
                data-column="Format"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-1 max-[839px]:row-start-2`}
            >
                <span className="me-2 hidden text-[var(--foreground-color-muted)] max-[839px]:inline">
                    Format{" "}
                </span>
                {typeof ruleSet.format === "string" && ruleSet.format ? ruleSet.format : "—"}
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
                        {outbound ? (
                            <ConfigListValue
                                text={outbound}
                                label={`Outbound for ${ruleSet.tag}`}
                            />
                        ) : (
                            "—"
                        )}
                    </div>
                </div>
            </td>
            <td
                data-column="Update"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-1 max-[839px]:row-start-4`}
            >
                <span className="me-2 hidden text-[var(--foreground-color-muted)] max-[839px]:inline">
                    Update{" "}
                </span>
                {interval}
            </td>
            <td
                data-column="Actions"
                className={`${cellClass} max-[839px]:col-start-2 max-[839px]:row-start-4`}
            >
                <ConfigListActions
                    name={ruleSet.tag}
                    disabled={disabled}
                    onEdit={onEdit}
                    onDelete={onDelete}
                />
            </td>
        </tr>
    );
};
