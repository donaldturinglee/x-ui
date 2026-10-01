import {
    Badge,
    IconButton,
    Label,
    ProgressBar,
    Switch,
    Tooltip,
} from "@gamecrafters/base-ui/react";
import {
    DataTrendingRegular,
    DeleteRegular,
    EditRegular,
    QrCodeRegular,
    type IconProps,
} from "@gamecrafters/base-ui-icons";
import { useRef, useState, type ComponentType, type ReactNode, type Ref } from "react";

import { formatBytes } from "@/features/overview/api";

import {
    daysLeft,
    expiryState,
    quotaState,
    quotaTone,
    usedBytes,
    usedFraction,
    type Client,
} from "../api";

import { DeleteClientDialog } from "./DeleteClientDialog";

interface ClientRowProps {
    client: Client;
    // The tag of each listener the subscriber may use, for the count's tooltip.
    inboundTags: string[];
    isOnline: boolean;
    // Whether the switch is waiting on the API, which is when it is held still.
    isToggling: boolean;
    // The time of day in milliseconds, which is what how long is left is counted
    // from.
    now: number;
    onToggle: (enable: boolean) => void;
    onEdit: () => void;
    onLinks: () => void;
    onTraffic: () => void;
}

interface CellProps {
    // The column the cell stands in, said beside the value once the row is
    // stacked and the header row above it has gone.
    title: string;
    children?: ReactNode;
}

// Below the width the shell drops its rail at, a row stops being a row: a dozen
// columns do not fit across a phone, so each cell becomes a line of its own with
// the name of its column beside the value, the way the reference stacks them.
const Cell = ({ title, children }: CellProps) => {
    return (
        <td className="px-4 max-[839px]:grid max-[839px]:min-h-9 max-[839px]:grid-cols-2 max-[839px]:items-center max-[839px]:justify-items-start max-[839px]:gap-x-1">
            <span aria-hidden className="hidden font-medium max-[839px]:block">
                {title}
            </span>
            {children}
        </td>
    );
};

interface RowActionProps {
    ref?: Ref<HTMLButtonElement>;
    icon: ComponentType<IconProps>;
    label: string;
    className?: string;
    onClick: () => void;
}

// One of the marks in the row's action column: the glyph and nothing around it,
// the way the reference draws them, with the room between them rather than
// inside them.
const RowAction = ({ ref, icon: Icon, label, className, onClick }: RowActionProps) => {
    return (
        <IconButton
            ref={ref}
            icon={<Icon size={21} />}
            aria-label={label}
            variant="invisible"
            className={`me-2 size-[21px] min-w-0 p-0 ${className ?? "text-[var(--foreground-color-default)]"}`}
            onClick={onClick}
        />
    );
};

// Timestamps arrive as whole seconds, which is what the API counts them in.
const toDate = (seconds: number) => new Date(seconds * 1000);

// A figure written as plain text that says more when it is pointed at or tabbed
// to. The tooltip wants something that can be focused, so the figure is a button
// that looks like the text around it.
const Explained = ({ text, children }: { text: string; children: ReactNode }) => {
    return (
        <Tooltip text={text}>
            <Badge
                as="button"
                type="button"
                variant="invisible"
                className="h-auto p-0 text-[14px] leading-[21px] font-normal"
            >
                {children}
            </Badge>
        </Tooltip>
    );
};

// A subscriber as the reference lays one out across the table: who they are,
// whether they may connect, where through, what can be done to them, how much of
// their quota and their time is left, and when they were last seen.
export const ClientRow = ({
    client,
    inboundTags,
    isOnline,
    isToggling,
    now,
    onToggle,
    onEdit,
    onLinks,
    onTraffic,
}: ClientRowProps) => {
    const deleteButtonRef = useRef<HTMLButtonElement>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const used = usedBytes(client);
    const fraction = usedFraction(client);
    const quota = quotaState(client);
    const expiry = expiryState(client, now);

    return (
        <tr className="h-[52px] border-b border-[var(--border-color-default)] last:border-b-0 max-[839px]:block max-[839px]:h-auto max-[839px]:pb-9 max-[839px]:last:border-b">
            <Cell title="Name">{client.name}</Cell>

            {/* Switched from the row rather than the form, the way the reference
                does it. The save carries everything else the subscriber has --
                the listeners above all -- because the API replaces what it is
                sent rather than merging it. */}
            <Cell title="Enable">
                <Switch
                    checked={client.enable}
                    disabled={isToggling}
                    onCheckedChange={onToggle}
                    className="w-fit align-middle"
                >
                    <Switch.Control>
                        <Switch.Thumb />
                    </Switch.Control>
                    <Switch.Label className="sr-only">Enable {client.name}</Switch.Label>
                    <Switch.HiddenInput />
                </Switch>
            </Cell>

            <Cell title="Description">{client.desc}</Cell>

            <Cell title="Group">{client.group}</Cell>

            {/* How many is what fits; which is what the tooltip is for. */}
            <Cell title="Inbounds">
                {inboundTags.length ? (
                    <Explained text={inboundTags.join(", ")}>{inboundTags.length}</Explained>
                ) : (
                    0
                )}
            </Cell>

            <Cell title="Action">
                <div className="flex items-center">
                    <RowAction icon={EditRegular} label={`Edit ${client.name}`} onClick={onEdit} />

                    <RowAction
                        ref={deleteButtonRef}
                        icon={DeleteRegular}
                        label={`Delete ${client.name}`}
                        className="text-[var(--foreground-color-danger)]"
                        onClick={() => setIsDeleting(true)}
                    />

                    {/* The code is the subscription link, with the individual
                        links beside it for pasting one node somewhere by hand. */}
                    <RowAction
                        icon={QrCodeRegular}
                        label={`Connection links for ${client.name}`}
                        onClick={onLinks}
                    />

                    {/* The counter says how much is left; this says when it went,
                        which is the question asked when a subscriber says it
                        stopped working on Tuesday. */}
                    <Tooltip text="Traffic chart">
                        <IconButton
                            icon={<DataTrendingRegular size={21} />}
                            aria-label={`Traffic for ${client.name}`}
                            variant="invisible"
                            className="size-[21px] min-w-0 p-0 text-[var(--foreground-color-default)]"
                            onClick={onTraffic}
                        />
                    </Tooltip>
                </div>

                {isDeleting && (
                    <DeleteClientDialog
                        client={client}
                        anchorRef={deleteButtonRef}
                        onClose={() => setIsDeleting(false)}
                    />
                )}
            </Cell>

            {/* What is shown is the current period, which is what the quota is
                held against; which way it went is what the tooltip is for. */}
            <Cell title="Volume">
                <div className="flex flex-col items-start">
                    <Tooltip text={`↓${formatBytes(client.down)} - ${formatBytes(client.up)}↑`}>
                        <Label
                            as="button"
                            type="button"
                            variant={
                                quota === "unlimited"
                                    ? "success"
                                    : quota === "spent"
                                      ? "danger"
                                      : "default"
                            }
                            className="h-[26px] rounded-[4px] px-2.5 text-[12px] font-normal whitespace-nowrap"
                        >
                            {formatBytes(used)} /{" "}
                            {client.volume ? formatBytes(client.volume) : "Unlimited"}
                        </Label>
                    </Tooltip>

                    {fraction !== null && (
                        <ProgressBar
                            progress={fraction * 100}
                            variant={quotaTone(client)}
                            aria-label={`${client.name} quota used`}
                            className="h-1 w-full rounded-none"
                        />
                    )}
                </div>
            </Cell>

            {/* Counted in whole days, with the date and the hour on the tooltip. */}
            <Cell title="Expiry">
                {expiry === "never" ? (
                    <Label
                        variant="success"
                        className="h-[26px] rounded-[4px] px-2.5 text-[12px] font-normal"
                    >
                        Never
                    </Label>
                ) : (
                    <Tooltip text={toDate(client.expiry).toLocaleString()}>
                        <Label
                            as="button"
                            type="button"
                            variant={expiry === "expired" ? "danger" : "default"}
                            className="h-[26px] rounded-[4px] px-2.5 text-[12px] font-normal whitespace-nowrap"
                        >
                            {expiry === "expired" ? "Expired" : `${daysLeft(client, now)} d`}
                        </Label>
                    </Tooltip>
                )}
            </Cell>

            {/* Derived from reported traffic rather than from a connection the
                panel holds, so a subscriber whose node died without saying so
                drops off on their own. */}
            <Cell title="Online">
                {isOnline ? (
                    <Badge variant="success" className="h-[22px] px-2.5">
                        Online
                    </Badge>
                ) : (
                    "—"
                )}
            </Cell>

            <Cell title="Created">
                {client.createdAt ? (
                    <Explained text={toDate(client.createdAt).toLocaleString()}>
                        {toDate(client.createdAt).toLocaleDateString()}
                    </Explained>
                ) : (
                    "—"
                )}
            </Cell>

            {/* Derived from reported traffic rather than from a connection the
                panel holds, so a subscriber who has never connected has nothing
                here. */}
            <Cell title="Last online">
                <span className="whitespace-nowrap">
                    {client.onlineAt ? toDate(client.onlineAt).toLocaleString() : "—"}
                </span>
            </Cell>
        </tr>
    );
};
