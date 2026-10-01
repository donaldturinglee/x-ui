import {
    Badge,
    Button,
    Card,
    Heading,
    IconButton,
    InlineMessage,
    List,
    Separator,
    SkeletonBox,
    Text,
    Tooltip,
} from "@gamecrafters/base-ui/react";
import type { IconProps } from "@gamecrafters/base-ui-icons";
import { useEffect, useId, useRef, type ComponentType, type ReactNode, type Ref } from "react";

// Listeners, routes out, and a node's DNS servers and
// rules, are all drawn the reference's way: a grid of cards, each one tag -- or a
// name, or a rule's place in the order -- with its kind under it, a few facts
// about it and a row of what can be done to it along its foot. The pieces are
// written once here rather than once per page with small differences that turn
// into large ones.

interface TaggedCardsProps {
    // Names the grid for whatever reads the page out, where a grid of cards is
    // otherwise a list of tags with nothing to say what they are.
    labelledBy: string;
    // Whether the read that fills the grid has yet to answer.
    isLoading: boolean;
    children: ReactNode;
}

// Six across on a wide screen, four on a laptop, three on a tablet and one on a
// phone, with the grid's gap the only room between them. Top-aligned rather than
// stretched, so a card is as tall as what it holds and a row of them lines up
// along the top.
export const TaggedCards = ({ labelledBy, isLoading, children }: TaggedCardsProps) => {
    return (
        <List
            variant="plain"
            spacing="condensed"
            aria-labelledby={labelledBy}
            className="grid grid-cols-1 items-start gap-2 min-[600px]:grid-cols-3 min-[840px]:grid-cols-4 min-[1145px]:grid-cols-6"
        >
            {/* A read that has not answered yet is shown as the cards it is
                going to fill, so they arrive in place rather than pushing
                everything below them down. */}
            {isLoading &&
                Array.from({ length: 4 }, (_, index) => (
                    <List.Item key={index}>
                        <SkeletonBox height="271px" className="rounded-[24px]" />
                    </List.Item>
                ))}

            {children}
        </List>
    );
};

interface TaggedCardProps {
    // What the card is known by, and what kind of thing it is under that.
    title: string;
    subtitle: string;
    // The facts about it, as the terms and values of the list the card holds.
    children: ReactNode;
    // The round buttons along its foot.
    actions: ReactNode;
    // What is asked on the card itself, laid over it while it is asked.
    question?: ReactNode;
}

// One card as the reference draws it. It is positioned and isolated so that a
// question asked on it can be laid over it and nothing else.
export const TaggedCard = ({ title, subtitle, children, actions, question }: TaggedCardProps) => {
    return (
        // Raised off the page by its shadow rather than outlined, which is how the
        // reference tells a card of its own from one of the overview's tiles.
        <Card
            padding="none"
            className="relative isolate min-w-[200px] gap-0 overflow-hidden rounded-[24px] border-0 bg-[var(--background-color-default)] shadow-[var(--shadow-resting-medium)]"
        >
            <div className="px-4 py-2.5">
                <Heading as="h3" className="truncate text-[22px] leading-7 font-normal">
                    {title}
                </Heading>
            </div>

            {/* Drawn up into the room under the tag rather than below it, with the
                line that closes the header off beneath it. */}
            <div className="-mt-[15px] min-h-5 border-b border-[var(--border-color-emphasis)] px-4 text-center text-[14px] leading-5 tracking-[0.25px] text-[var(--foreground-color-muted)]">
                {subtitle}
            </div>

            <dl className="grid grid-cols-2 gap-2 p-4 text-[14px] leading-5 tracking-[0.25px] [&>*]:min-w-0 [&>*]:break-words">
                {children}
            </dl>

            <Separator />

            <div className="flex min-h-[52px] items-center gap-2">{actions}</div>

            {question}
        </Card>
    );
};

interface CardActionProps {
    ref?: Ref<HTMLButtonElement>;
    icon: ComponentType<IconProps>;
    // What the button is called where it is read out rather than pointed at. It
    // names the tag as well, so a page of them are still told apart.
    label: string;
    // What the tooltip says, where the card it stands on already says which one.
    description: string;
    // The one that cannot be taken back is drawn in a colour of its own.
    tone?: "default" | "attention";
    loading?: boolean;
    onClick: () => void;
}

// One of the round buttons along the foot of a card, as wide as it is tall and
// with nothing between it and the next but the gap. What it does is said above
// it, clear of the card below.
//
// The ref is handed to the tooltip rather than the button: the tooltip puts one
// of its own on whatever it wraps and forwards its own ref to it, so a ref on the
// button would never be set.
export const CardAction = ({
    ref,
    icon: Icon,
    label,
    description,
    tone = "default",
    loading,
    onClick,
}: CardActionProps) => {
    return (
        <Tooltip ref={ref} text={description} direction="n">
            <IconButton
                icon={<Icon size={24} />}
                aria-label={label}
                variant="invisible"
                loading={loading}
                className={`size-12 rounded-full ${
                    tone === "attention"
                        ? "text-[var(--foreground-color-attention)]"
                        : "text-[var(--foreground-color-default)]"
                }`}
                onClick={onClick}
            />
        </Tooltip>
    );
};

interface CardCountProps {
    // What is being counted, by name.
    names: string[];
    // Whether the names are only some of them, which the count then says.
    isPartial?: boolean;
    // What is said when there are none.
    none?: ReactNode;
}

// How many of something a card's subject has, where the count is what fits and
// who they are is what the tooltip over it is for. The count is a button so the
// tooltip can be reached without a pointer.
export const CardCount = ({ names, isPartial = false, none = "—" }: CardCountProps) => {
    if (names.length === 0) {
        return <>{none}</>;
    }

    return (
        <Tooltip text={names.join(", ")}>
            <Badge
                as="button"
                type="button"
                variant="invisible"
                className="h-5 p-0 text-[14px] leading-5 font-normal tracking-[0.25px]"
            >
                {names.length}
                {isPartial && "+"}
            </Badge>
        </Tooltip>
    );
};

interface CardQuestionProps {
    title: string;
    // What the answer costs, said before it is given.
    children: ReactNode;
    // Whether yes is waiting on the API.
    isMutating: boolean;
    // What the API said when it refused.
    error?: Error;
    // Held back when the answer is already known to be refused, which is then
    // what the question says instead.
    canConfirm?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

// A question asked inside the card it is about rather than over the whole page,
// which is where the reference asks it: the card is dimmed under a small one of
// its own, so which tag it is about is never in doubt, and the rest of the page
// is left as it was.
export const CardQuestion = ({
    title,
    children,
    isMutating,
    error,
    canConfirm = true,
    onConfirm,
    onCancel,
}: CardQuestionProps) => {
    const titleId = useId();
    const descriptionId = useId();
    const cancelRef = useRef<HTMLButtonElement>(null);

    // What is being asked for cannot be undone, so the way out of it is what the
    // question opens on rather than the way through.
    useEffect(() => {
        cancelRef.current?.focus();
    }, []);

    return (
        <div
            className="absolute inset-0 z-[var(--z-index-overlay)] flex items-center justify-center"
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    onCancel();
                }
            }}
        >
            {/* Pressing beside the question puts it away, the way pressing
                outside a menu does. */}
            <div
                aria-hidden
                className="absolute inset-0 bg-[var(--overlay-backdrop-background-color)]"
                onClick={onCancel}
            />

            <Card
                role="alertdialog"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                padding="none"
                className="relative mx-4 gap-0 rounded-[8px] border-0 bg-[var(--background-color-default)] shadow-[var(--shadow-resting-small)]"
            >
                <Heading
                    as="h4"
                    id={titleId}
                    className="px-4 py-2.5 text-[22px] leading-7 font-normal"
                >
                    {title}
                </Heading>

                <Separator />

                <Text
                    as="p"
                    id={descriptionId}
                    className="m-0 p-4 text-[14px] leading-5 tracking-[0.25px]"
                >
                    {children}
                </Text>

                {error && (
                    <InlineMessage variant="critical" className="px-4 pb-2">
                        {error.message}
                    </InlineMessage>
                )}

                {/* Outlined in the colour of what each answer does, rather than
                    one of them filled in as the way through. */}
                <div className="flex min-h-[52px] items-center gap-2 p-2">
                    <Button
                        variant="danger"
                        loading={isMutating}
                        disabled={!canConfirm}
                        className="h-9 min-w-16 rounded-[4px] border-[var(--border-color-danger-emphasis)] bg-transparent px-2 text-[14px]"
                        onClick={onConfirm}
                    >
                        Yes
                    </Button>
                    <Button
                        ref={cancelRef}
                        disabled={isMutating}
                        className="h-9 min-w-16 rounded-[4px] border-[var(--border-color-success-emphasis)] bg-transparent px-2 text-[14px] text-[var(--foreground-color-success)]"
                        onClick={onCancel}
                    >
                        No
                    </Button>
                </div>
            </Card>
        </div>
    );
};
