import { DocumentDismissRegular, DocumentEditRegular } from "@gamecrafters/base-ui-icons";
import { useRef, useState } from "react";

import { CardAction, CardQuestion, TaggedCard } from "@/components/TaggedCard";

import { downloadDetour, ruleSetTypeName, type RuleSet } from "../api";

interface RuleSetCardProps {
    ruleSet: RuleSet;
    onEdit: () => void;
    onDelete: () => void;
}

// A rule set as the reference draws one: the tag rules name it by, where it is
// kept, what it is written in, and for one downloaded, the route out it comes
// through and how often it is fetched again.
export const RuleSetCard = ({ ruleSet, onEdit, onDelete }: RuleSetCardProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const interval =
        typeof ruleSet.update_interval === "string" && ruleSet.update_interval
            ? ruleSet.update_interval
            : null;

    // Asked for from the button beside it, so that is where focus goes back to
    // when the answer is no.
    const closeDelete = () => {
        setIsDeleting(false);
        deleteButtonRef.current?.focus();
    };

    return (
        <TaggedCard
            title={ruleSet.tag}
            subtitle={ruleSetTypeName(ruleSet.type)}
            actions={
                <>
                    <CardAction
                        icon={DocumentEditRegular}
                        label={`Edit ${ruleSet.tag}`}
                        description="Edit"
                        onClick={onEdit}
                    />

                    <CardAction
                        ref={deleteButtonRef}
                        icon={DocumentDismissRegular}
                        label={`Delete ${ruleSet.tag}`}
                        description="Delete"
                        tone="attention"
                        onClick={() => setIsDeleting(true)}
                    />
                </>
            }
            question={
                // Taken off the page rather than out of the document, so there is
                // nothing to wait on: the page's Save is what writes it.
                isDeleting && (
                    <CardQuestion
                        title="Delete"
                        isMutating={false}
                        onConfirm={onDelete}
                        onCancel={closeDelete}
                    >
                        Are you sure? A rule that names it is left naming nothing.
                    </CardQuestion>
                )
            }
        >
            <dt>Format</dt>
            <dd>{typeof ruleSet.format === "string" && ruleSet.format ? ruleSet.format : "—"}</dd>

            <dt>Outbound</dt>
            <dd>{downloadDetour(ruleSet) ?? "—"}</dd>

            <dt>Update</dt>
            <dd>{interval ?? "—"}</dd>
        </TaggedCard>
    );
};
