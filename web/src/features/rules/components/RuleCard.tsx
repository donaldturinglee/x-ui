import { DocumentDismissRegular, DocumentEditRegular } from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { CardAction, CardQuestion, TaggedCard } from "@/components/TaggedCard";

import { ruleConditions, ruleKind, type RouteRule } from "../api";

interface RuleCardProps {
    rule: RouteRule;
    // Where it stands in the order, which is what it is known by: a rule has no
    // name of its own, and the order is what decides which one a connection
    // goes by.
    position: number;
    // The routes out a rule can send a connection to, so a rule sending it to
    // one that has gone can say so.
    outboundTags: string[];
    onEdit: () => void;
    onDelete: () => void;
}

// A rule as the reference draws one: what it does, where it sends what it
// matches, how much it matches on, and whether it acts on what it does not
// match instead.
export const RuleCard = ({ rule, position, outboundTags, onEdit, onDelete }: RuleCardProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const name = `rule ${position + 1}`;
    const outbound = typeof rule.outbound === "string" && rule.outbound ? rule.outbound : null;

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

            {/* A route out deleted from under the rule is said to be missing,
                since the node will not start with a rule pointing at nothing. */}
            <dt>Outbound</dt>
            <dd>
                {outbound === null ? (
                    "—"
                ) : outboundTags.includes(outbound) ? (
                    outbound
                ) : (
                    <span className="text-[var(--foreground-color-attention)]">
                        {outbound} missing
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
