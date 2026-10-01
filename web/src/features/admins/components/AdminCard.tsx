import { PersonEditRegular, TextBulletListSquareRegular } from "@gamecrafters/base-ui-icons";

import { CardAction, TaggedCard } from "@/components/TaggedCard";
import type { Operator } from "@/features/auth/api";

import { parseSignIn } from "../api";

interface AdminCardProps {
    operator: Operator;
    // Whether this is the account signed in, which is the only one whose
    // credentials can be changed from here.
    isYou: boolean;
    onEdit: () => void;
    onChanges: () => void;
}

// An operator as the reference draws one: the account's name, and when and from
// where it was last signed in to, with its changes and -- on the operator's own
// card -- its credentials along the foot. The API changes the credentials of the
// session asking and no other, so another operator's card has no edit to offer.
// Whether signing in to the account takes a code as well is said under the rest;
// it is turned on and off from the settings, by the operator it belongs to.
export const AdminCard = ({ operator, isYou, onEdit, onChanges }: AdminCardProps) => {
    const signIn = parseSignIn(operator.lastSignIn);

    return (
        <TaggedCard
            title={operator.username}
            subtitle="Last sign-in"
            actions={
                <>
                    {isYou && (
                        <CardAction
                            icon={PersonEditRegular}
                            label="Edit your credentials"
                            description="Edit"
                            onClick={onEdit}
                        />
                    )}

                    <CardAction
                        icon={TextBulletListSquareRegular}
                        label={`Changes by ${operator.username}`}
                        description="Changes"
                        onClick={onChanges}
                    />
                </>
            }
        >
            <dt>Date</dt>
            <dd>{signIn?.date ?? "—"}</dd>

            <dt>Time</dt>
            <dd>{signIn?.time ?? "—"}</dd>

            <dt>IP</dt>
            <dd>{signIn?.address ?? "—"}</dd>

            <dt>Two-factor</dt>
            <dd>{operator.twoFactor ? "On" : "Off"}</dd>
        </TaggedCard>
    );
};
