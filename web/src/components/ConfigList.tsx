import {
    ActionList,
    ActionMenu,
    Button,
    Dialog,
    IconButton,
    SkeletonText,
    Tooltip,
} from "@gamecrafters/base-ui/react";
import {
    ArrowDownRegular,
    ArrowUpRegular,
    DeleteRegular,
    EditRegular,
    MoreHorizontalRegular,
} from "@gamecrafters/base-ui-icons";
import { useRef, useState, type ReactNode, type RefObject } from "react";

interface ConfigListTableProps {
    labelledBy: string;
    columns: string[];
    isLoading: boolean;
    isEmpty: boolean;
    hasError: boolean;
    emptyMessage: string;
    children: ReactNode;
}

export const ConfigListTable = ({
    labelledBy,
    columns,
    isLoading,
    isEmpty,
    hasError,
    emptyMessage,
    children,
}: ConfigListTableProps) => (
    <div className="overflow-hidden rounded-[4px] bg-[var(--background-color-default)] shadow-[var(--shadow-resting-medium)]">
        <div className="overflow-x-auto">
            <table
                aria-labelledby={labelledBy}
                aria-busy={isLoading}
                className="w-full min-w-[800px] border-collapse text-start text-[14px] leading-[21px] max-[839px]:block max-[839px]:min-w-0"
            >
                <thead className="max-[839px]:hidden">
                    <tr>
                        {columns.map((column) => (
                            <th
                                key={column}
                                scope="col"
                                className="h-14 border-b border-[var(--border-color-default)] px-3 text-start font-medium whitespace-nowrap"
                            >
                                {column}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="max-[839px]:block">
                    {isLoading ? (
                        <tr>
                            <td colSpan={columns.length} className="p-4 max-[839px]:block">
                                <SkeletonText lines={3} />
                            </td>
                        </tr>
                    ) : isEmpty && !hasError ? (
                        <tr>
                            <td
                                colSpan={columns.length}
                                className="p-4 text-[var(--foreground-color-muted)] max-[839px]:block"
                            >
                                {emptyMessage}
                            </td>
                        </tr>
                    ) : (
                        children
                    )}
                </tbody>
            </table>
        </div>
    </div>
);

// A full tag remains available by touch and keyboard as well as on hover.
export const ConfigListValue = ({ text, label }: { text: string; label: string }) => {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [isOpen, setIsOpen] = useState(false);

    return (
        <>
            <Tooltip ref={buttonRef} type="description" text={text}>
                <button
                    type="button"
                    className="block max-w-full cursor-pointer truncate text-start"
                    onClick={() => setIsOpen(true)}
                >
                    {text}
                </button>
            </Tooltip>
            {isOpen && (
                <Dialog
                    title={label}
                    width={420}
                    onClose={() => setIsOpen(false)}
                    returnFocusRef={buttonRef}
                    footerButtons={[{ content: "Close", onClick: () => setIsOpen(false) }]}
                >
                    <p className="p-4 break-all">{text}</p>
                </Dialog>
            )}
        </>
    );
};

interface ConfigListActionsProps {
    name: string;
    disabled: boolean;
    onEdit: (anchor: HTMLButtonElement | null) => void;
    onDelete: (anchor: HTMLButtonElement | null) => void;
    move?: {
        canMoveUp: boolean;
        canMoveDown: boolean;
        onMoveUp: () => void;
        onMoveDown: () => void;
    };
}

export const ConfigListActions = ({
    name,
    disabled,
    onEdit,
    onDelete,
    move,
}: ConfigListActionsProps) => {
    const editRef = useRef<HTMLButtonElement>(null);
    const deleteRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLButtonElement>(null);
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    const moveAndClose = (onMove: () => void) => {
        setIsMenuOpen(false);
        onMove();
        // Moving a focused row in the DOM can clear focus. Restore it once the
        // reordered row has been committed, using its stable menu anchor.
        requestAnimationFrame(() => menuRef.current?.focus());
    };

    return (
        <div className="flex items-center gap-1 max-[839px]:justify-end">
            <Tooltip ref={editRef} type="description" text="Edit">
                <IconButton
                    icon={<EditRegular size={20} />}
                    aria-label={`Edit ${name}`}
                    variant="invisible"
                    disabled={disabled}
                    className="size-8 rounded-full"
                    onClick={() => onEdit(editRef.current)}
                />
            </Tooltip>
            <div className="max-[839px]:hidden">
                <Tooltip ref={deleteRef} type="description" text="Delete">
                    <IconButton
                        icon={<DeleteRegular size={20} />}
                        aria-label={`Delete ${name}`}
                        variant="invisible"
                        disabled={disabled}
                        className="size-8 rounded-full text-[var(--foreground-color-danger)]"
                        onClick={() => onDelete(deleteRef.current)}
                    />
                </Tooltip>
            </div>
            <div className={move ? "" : "hidden max-[839px]:block"}>
                <ActionMenu open={isMenuOpen} onOpenChange={setIsMenuOpen} anchorRef={menuRef}>
                    <ActionMenu.Anchor>
                        <IconButton
                            ref={menuRef}
                            icon={<MoreHorizontalRegular size={20} />}
                            aria-label={`More actions for ${name}`}
                            variant="invisible"
                            disabled={disabled}
                            className="size-8 rounded-full"
                        />
                    </ActionMenu.Anchor>
                    <ActionMenu.Overlay align="end">
                        <ActionList>
                            {move && (
                                <>
                                    <ActionList.Item
                                        disabled={!move.canMoveUp}
                                        onSelect={(event) => {
                                            event.preventDefault();
                                            moveAndClose(move.onMoveUp);
                                        }}
                                    >
                                        <ActionList.LeadingVisual>
                                            <ArrowUpRegular />
                                        </ActionList.LeadingVisual>
                                        Move up
                                    </ActionList.Item>
                                    <ActionList.Item
                                        disabled={!move.canMoveDown}
                                        onSelect={(event) => {
                                            event.preventDefault();
                                            moveAndClose(move.onMoveDown);
                                        }}
                                    >
                                        <ActionList.LeadingVisual>
                                            <ArrowDownRegular />
                                        </ActionList.LeadingVisual>
                                        Move down
                                    </ActionList.Item>
                                    <ActionList.Divider />
                                </>
                            )}
                            <ActionList.Item
                                variant="danger"
                                onSelect={() => {
                                    setIsMenuOpen(false);
                                    onDelete(menuRef.current);
                                }}
                            >
                                <ActionList.LeadingVisual>
                                    <DeleteRegular />
                                </ActionList.LeadingVisual>
                                Delete
                            </ActionList.Item>
                        </ActionList>
                    </ActionMenu.Overlay>
                </ActionMenu>
            </div>
        </div>
    );
};

interface ConfigListDeleteDialogProps {
    name: string;
    message: string;
    onConfirm: () => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export const ConfigListDeleteDialog = ({
    name,
    message,
    onConfirm,
    onClose,
    returnFocusRef,
}: ConfigListDeleteDialogProps) => {
    const cancelRef = useRef<HTMLButtonElement>(null);

    return (
        <Dialog
            title="Delete"
            subtitle={name}
            role="alertdialog"
            width={440}
            initialFocusRef={cancelRef}
            returnFocusRef={returnFocusRef}
            onClose={onClose}
            renderFooter={() => (
                <Dialog.Footer key="footer" className="items-center p-2">
                    <Button variant="danger" onClick={onConfirm}>
                        Yes
                    </Button>
                    <Button ref={cancelRef} onClick={onClose}>
                        No
                    </Button>
                </Dialog.Footer>
            )}
        >
            <p className="p-4 text-[14px]">{message}</p>
        </Dialog>
    );
};
