import { Button, Dialog } from "@gamecrafters/base-ui/react";
import type { ReactNode, RefObject } from "react";

import { DocLink } from "./DocLink";

interface FormDialogProps {
    title: string;
    // Where the proxy core documents what is being written, for the mark at the
    // end of the title, if anywhere.
    docs?: { href: string; label: string };
    // The form the dialog's body holds, which the button at its foot submits.
    formId: string;
    isSaving: boolean;
    // Held back while there is no form yet to submit, as while what it amends
    // is still being read.
    canSave?: boolean;
    // Set in from the edges and the title as a card's content is, where the
    // reference leaves its dialog's body the card's own padding rather than
    // laying the form right up to the line.
    isBodyPadded?: boolean;
    // As wide as the reference's dialog for the same thing: most are 800
    // pixels, and one that asks for a few short fields is narrower.
    width?: number;
    onClose: () => void;
    // Closing hands focus back to whatever opened the dialog, so the page is
    // left where it was rather than back at the top of the document.
    returnFocusRef: RefObject<HTMLButtonElement | null>;
    children: ReactNode;
}

// The reference's dialog for writing something and amending it: its title, with
// the mark that leads to the proxy core's documentation where there is any, a
// line under it, the form laid right up to that line, and the buttons that put
// it away or save it at the foot. The title's row is as tall as the reference's,
// whose mark sits a pixel higher than the text beside it, with or without one.
//
// It has no button of its own to close it in the title: the one at its foot
// does that, and Escape still does. Taller or wider than the window allows, it
// keeps the reference's margin to the window's edge, and its body scrolls.
//
// The head and the foot are keyed: the design system sets them side by side in
// a list it builds without the checks React makes in development, so React
// finds them there unkeyed and says so.
export const FormDialog = ({
    title,
    docs,
    formId,
    isSaving,
    canSave = true,
    isBodyPadded = false,
    width = 800,
    onClose,
    returnFocusRef,
    children,
}: FormDialogProps) => {
    return (
        <Dialog
            title={title}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width={width}
            className="max-h-[calc(100dvh-48px)] max-w-[calc(100dvw-48px)] rounded-[8px]"
            renderHeader={({ title: heading, dialogLabelId }) => (
                <Dialog.Header
                    key="header"
                    className={`flex items-center border-b border-[var(--border-color-default)] px-4 py-2 shadow-none ${docs ? "min-h-[46px]" : "min-h-[45px]"}`}
                >
                    <Dialog.Title
                        id={dialogLabelId}
                        className="grow text-[22px] leading-7 font-normal"
                    >
                        {heading}
                    </Dialog.Title>
                    {docs && (
                        <DocLink
                            href={docs.href}
                            label={docs.label}
                            className="text-[22px] leading-7"
                        />
                    )}
                </Dialog.Header>
            )}
            renderBody={({ children: body }) => (
                <Dialog.Body className={isBodyPadded ? "px-6 pt-4 pb-6" : "px-4 py-0"}>
                    {body}
                </Dialog.Body>
            )}
            renderFooter={() => (
                <Dialog.Footer key="footer" className="min-h-[52px] items-center p-2">
                    {/* Outlined and tinted in the accent, the reference's pair. */}
                    <Button
                        disabled={isSaving}
                        className="h-9 min-w-16 rounded-[4px] border border-[var(--border-color-accent-emphasis)] bg-transparent px-2 text-[14px] font-medium text-[var(--foreground-color-accent)]"
                        onClick={onClose}
                    >
                        Cancel
                    </Button>
                    {/* The footer belongs to the dialog rather than to the form, so
                        the button that submits it names the form it is sending. */}
                    <Button
                        type="submit"
                        form={formId}
                        loading={isSaving}
                        disabled={!canSave}
                        className="h-9 min-w-16 rounded-[4px] border-0 bg-[var(--background-color-accent-muted)] px-2 text-[14px] font-medium text-[var(--foreground-color-accent)]"
                    >
                        Save
                    </Button>
                </Dialog.Footer>
            )}
        >
            {children}
        </Dialog>
    );
};
