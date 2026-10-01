import { DocumentDismissRegular, DocumentEditRegular } from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { CardAction, CardQuestion, TaggedCard } from "@/components/TaggedCard";

import { ruleConditions, ruleKind, type DnsRule } from "../api";

interface DnsRuleCardProps {
    rule: DnsRule;
    // Where it stands in the order, which is what it is known by: a rule has no
    // name of its own, and the order is what decides which one answers.
    position: number;
    // The servers the page holds, so a rule sending queries to one that has gone
    // can say so.
    serverTags: string[];
    onEdit: () => void;
    onDelete: () => void;
}

// A rule as the reference draws one: what it does, where it sends what it
// matches, how much it matches on, and whether it acts on what it does not
// match instead.
export const DnsRuleCard = ({ rule, position, serverTags, onEdit, onDelete }: DnsRuleCardProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const name = `rule ${position + 1}`;
    const server = typeof rule.server === "string" && rule.server ? rule.server : null;

    const closeDelete = () => {
        setIsDeleting(false);
        deleteButtonRef.current?.focus();
    };

    return (
        <TaggedCard
            title={String(position + 1)}
            subtitle={ruleKind(rule)}
            actions={
                <>
                    <CardAction
                        icon={DocumentEditRegular}
                        label={`Edit ${name}`}
                        description="Edit"
                        onClick={onEdit}
                    />

                    <CardAction
                        ref={deleteButtonRef}
                        icon={DocumentDismissRegular}
                        label={`Delete ${name}`}
                        description="Delete"
                        tone="attention"
                        onClick={() => setIsDeleting(true)}
                    />
                </>
            }
            question={
                isDeleting && (
                    <CardQuestion
                        title="Delete"
                        isMutating={false}
                        onConfirm={onDelete}
                        onCancel={closeDelete}
                    >
                        Are you sure? What it matched goes on to the rules after it.
                    </CardQuestion>
                )
            }
        >
            {/* The core routes a rule that names no action, so that is what one
                is said to do. */}
            <dt>Action</dt>
            <dd>{typeof rule.action === "string" ? rule.action : "route"}</dd>

            {/* A server deleted out from under the rule is said to be missing,
                since the node will not start with a rule pointing at nothing. */}
            <dt>Server</dt>
            <dd>
                {server === null ? (
                    "—"
                ) : serverTags.includes(server) ? (
                    server
                ) : (
                    <span className="text-[var(--foreground-color-attention)]">
                        {server} missing
                    </span>
                )}
            </dd>

            <dt>Rules</dt>
            <dd>{ruleConditions(rule)}</dd>

            <dt>Invert</dt>
            <dd>{rule.invert === true ? "Yes" : "No"}</dd>
        </TaggedCard>
    );
};
