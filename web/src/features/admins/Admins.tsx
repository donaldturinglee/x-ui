import { Button, Heading, InlineMessage, List, Stack } from "@gamecrafters/base-ui/react";
import { useId, useRef, useState } from "react";

import { TaggedCards } from "@/components/TaggedCard";
import { useMe } from "@/features/auth/api";

import { useUsers } from "./api";
import { AdminCard } from "./components/AdminCard";
import { ChangesDialog, TokensDialog } from "./components/AdminDialogs";
import { CredentialsDialog } from "./components/CredentialsDialog";

// Which dialog is open. The change log is everybody's until an operator's card
// asks for theirs.
type Open =
    { dialog: "changes"; actor?: string } | { dialog: "tokens" } | { dialog: "credentials" };

const BUTTON = "h-9 min-w-16 rounded-[4px] px-4 text-[14px] shadow-[var(--shadow-resting-small)]";

// The panel's operators, laid out as the reference lays out its admins: the
// change log and the API tokens centred over a grid of cards, one an operator.
//
// There is no adding or removing an operator here, as there is none in the
// reference: an account is made with `x-ui-cli admin`, which is also the
// way back in for one nobody can sign in to.
export const Admins = () => {
    const titleId = useId();
    const changesButtonRef = useRef<HTMLButtonElement>(null);
    const tokensButtonRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState<Open | null>(null);

    const { data: operators, error, isLoading } = useUsers();
    const { data: me } = useMe();

    return (
        <>
            <Stack gap="condensed">
                <Heading as="h2" id={titleId} className="sr-only">
                    Operators
                </Heading>

                {/* Spaced as the reference spaces them: the first with a little
                    room either side of it and the second with none. */}
                <div className="flex justify-center [&>*:first-child]:mx-[5px]">
                    <Button
                        ref={changesButtonRef}
                        variant="primary"
                        className={BUTTON}
                        onClick={() => setOpen({ dialog: "changes" })}
                    >
                        Changes
                    </Button>
                    <Button
                        ref={tokensButtonRef}
                        variant="primary"
                        className={BUTTON}
                        onClick={() => setOpen({ dialog: "tokens" })}
                    >
                        API tokens
                    </Button>
                </div>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

                <TaggedCards labelledBy={titleId} isLoading={isLoading}>
                    {operators?.map((operator) => (
                        <List.Item key={operator.id}>
                            <AdminCard
                                operator={operator}
                                isYou={operator.id === me?.id}
                                onEdit={() => setOpen({ dialog: "credentials" })}
                                onChanges={() =>
                                    setOpen({ dialog: "changes", actor: operator.username })
                                }
                            />
                        </List.Item>
                    ))}
                </TaggedCards>
            </Stack>

            {/* What a card opened is handed back to the change log's button, which
                is always there, rather than to a card's, which is not always. */}
            {open?.dialog === "changes" && (
                <ChangesDialog
                    actor={open.actor}
                    onClose={() => setOpen(null)}
                    returnFocusRef={changesButtonRef}
                />
            )}

            {open?.dialog === "tokens" && (
                <TokensDialog onClose={() => setOpen(null)} returnFocusRef={tokensButtonRef} />
            )}

            {open?.dialog === "credentials" && me && (
                <CredentialsDialog
                    username={me.username}
                    onClose={() => setOpen(null)}
                    returnFocusRef={changesButtonRef}
                />
            )}
        </>
    );
};
