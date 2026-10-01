import { Heading } from "@gamecrafters/base-ui/react";
import { useId, type ReactNode } from "react";

interface FormSectionProps {
    // Written small over a line at the head of the block, with anything that
    // acts on the block standing straight after it. A block the reference draws
    // without one is named by `label` instead, for what reads it out.
    title?: string;
    titleAction?: ReactNode;
    label?: string;
    // Set flush along the top of the block, its line running edge to edge, where
    // the reference heads the block itself rather than through the card's own
    // title -- as it heads each rule a logical rule combines.
    hasFlushTitle?: boolean;
    // What acts on the section as a whole, along its foot: straight under the
    // fields, or eight pixels below them where the reference sets it apart.
    actions?: ReactNode;
    hasSpacedActions?: boolean;
    // Rounded as the dialog is rather than as a card is, where the reference
    // rounds it so.
    isRoundedLarge?: boolean;
    children: ReactNode;
}

// One of the reference's cards inside a dialog: a raised block with its name
// small and centred over a line at its head, the fields under that running the
// full width of the block, and whatever acts on the block along its foot. The
// blocks stand one straight after another. One without a name starts with its
// fields at its top edge, as the reference's does.
//
// The block is a column, so the space around the name stays inside it rather
// than running out through its top.
export const FormSection = ({
    title,
    titleAction,
    label,
    hasFlushTitle = false,
    actions,
    hasSpacedActions = false,
    isRoundedLarge = false,
    children,
}: FormSectionProps) => {
    const headingId = useId();

    return (
        <section
            aria-labelledby={title ? headingId : undefined}
            aria-label={title ? undefined : label}
            className={`flex flex-col bg-[var(--overlay-background-color)] shadow-[var(--shadow-resting-medium)] ${isRoundedLarge ? "rounded-[8px]" : "rounded-[4px]"}`}
        >
            {/* Flush, the name and what acts on the block share one line of
                text, a space apart, which is as tall as whatever stands on it
                makes it. */}
            {title && (
                <div
                    className={
                        hasFlushTitle
                            ? "border-b border-[var(--border-color-emphasis)] px-4 text-center text-[14px] leading-5"
                            : "mx-4 my-2.5 flex items-center justify-center gap-1 border-b border-[var(--border-color-emphasis)] pb-1"
                    }
                >
                    <Heading
                        as="h2"
                        id={headingId}
                        className={`text-center text-[14px] leading-5 font-normal tracking-[0.25px] text-[var(--foreground-color-muted)] ${hasFlushTitle ? "inline" : ""}`}
                    >
                        {title}
                    </Heading>
                    {hasFlushTitle && titleAction ? " " : null}
                    {titleAction}
                </div>
            )}

            {children}

            {actions && (
                <div
                    className={`flex min-h-[52px] items-center justify-end px-2 ${hasSpacedActions ? "py-2" : "pb-2"}`}
                >
                    {actions}
                </div>
            )}
        </section>
    );
};
