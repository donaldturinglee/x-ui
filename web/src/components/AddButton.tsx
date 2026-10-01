import { Button } from "@gamecrafters/base-ui/react";
import type { Ref } from "react";

interface AddButtonProps {
    ref?: Ref<HTMLButtonElement>;
    // What it adds, which is what it is read out as.
    label: string;
    // Whether it shows that rather than the one word. A page that adds more than
    // one kind of thing from the same row says which on each button, as the
    // reference's DNS page does.
    spellsOut?: boolean;
    // Held back while what it adds to has yet to be read, on a page that adds
    // to a copy of a document rather than through the API.
    disabled?: boolean;
    onClick: () => void;
}

// The button a page adds one more of what it lists with, as the reference draws
// it: one short word in a small raised box. It is read out as what it adds, since
// "Add" alone does not say which of the things a page offers it is.
export const AddButton = ({ ref, label, spellsOut, disabled, onClick }: AddButtonProps) => {
    return (
        <Button
            ref={ref}
            variant="primary"
            aria-label={spellsOut ? undefined : label}
            disabled={disabled}
            className="h-9 min-w-16 rounded-[4px] px-4 text-[14px] shadow-[var(--shadow-resting-small)]"
            onClick={onClick}
        >
            {spellsOut ? label : "Add"}
        </Button>
    );
};
