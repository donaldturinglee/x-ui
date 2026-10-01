import { ActionList, ActionMenu, Button, NativeSelect } from "@gamecrafters/base-ui/react";
import { useId, type ReactNode } from "react";

import { useInbounds } from "@/features/inbounds/api";
import {
    hasListenOption,
    LISTEN_OPTIONS,
    udpTimeoutMinutes,
    withListenOption,
    type ListenOption,
} from "@/lib/listen";
import { useMenuInDialog } from "@/lib/menu";

import { FilledSelect, FilledSwitch, FilledTextInput } from "./FilledField";
import { FormSection } from "./FormSection";

interface ListenSectionProps {
    // Where it listens, the first row of the block. The address and the port are
    // fields of a listener's own rather than options, so the row is handed in.
    address: ReactNode;
    // The options of what listens, which the rest of the block reads its fields
    // off and hands back whole with them changed.
    options: Record<string, unknown>;
    onChange: (options: Record<string, unknown>) => void;
    // What listens is known by this, and is not something it can forward to.
    tag: string;
    // Held still while the options the fields are read off cannot be read.
    disabled?: boolean;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

// The reference's block for where a listener listens: the address and the port,
// then the rows the listen options every binding type shares fill in as their
// groups are switched on from the menu at the block's foot. The
// detour's row is always there, empty until it is switched on, which is what
// holds the options below the address as far down as the reference's.
//
// An option is kept as it is set, cleared text included, as the reference keeps
// it: a group goes from the options only when it is switched off, so a row does
// not vanish while its field is being typed over.
export const ListenSection = ({
    address,
    options,
    onChange,
    tag,
    disabled = false,
}: ListenSectionProps) => {
    const { data: inbounds } = useInbounds();
    const detourId = useId();
    const udpTimeoutId = useId();
    const keepAliveId = useId();
    const keepAliveIntervalId = useId();

    // What can be forwarded to: every listener but this one.
    const inboundTags = (inbounds ?? [])
        .map((inbound) => inbound.tag)
        .filter((other) => other !== tag);

    const setOption = (key: string, value: unknown) => onChange({ ...options, [key]: value });
    const toggleOption = (option: ListenOption) =>
        onChange(
            withListenOption(
                options,
                option,
                !hasListenOption(options, option),
                inboundTags[0] ?? "",
            ),
        );

    const text = (key: string) => {
        const value = options[key];

        return typeof value === "string" ? value : "";
    };

    return (
        <FormSection
            title="Listen"
            actions={
                <ListenOptionsMenu options={options} disabled={disabled} onToggle={toggleOption} />
            }
        >
            {/* Rows eight pixels apart. */}
            <div className="flex flex-col gap-2">
                {address}

                <div className={ROW}>
                    {hasListenOption(options, "detour") && (
                        <FilledSelect
                            id={detourId}
                            label="Forward to inbound"
                            className={FIELD}
                            value={text("detour")}
                            onChange={(event) => setOption("detour", event.target.value)}
                        >
                            {!inboundTags.includes(text("detour")) && (
                                <NativeSelect.Option value={text("detour")}>
                                    {text("detour") || "None"}
                                </NativeSelect.Option>
                            )}
                            {inboundTags.map((other) => (
                                <NativeSelect.Option key={other} value={other}>
                                    {other}
                                </NativeSelect.Option>
                            ))}
                        </FilledSelect>
                    )}
                </div>

                {hasListenOption(options, "tcp") && (
                    <div className={ROW}>
                        <FilledSwitch
                            label="TCP Fast Open"
                            className={FIELD}
                            checked={options.tcp_fast_open === true}
                            onCheckedChange={(on) => setOption("tcp_fast_open", on)}
                        />
                        <FilledSwitch
                            label="TCP Multi Path"
                            className={FIELD}
                            checked={options.tcp_multi_path === true}
                            onCheckedChange={(on) => setOption("tcp_multi_path", on)}
                        />
                    </div>
                )}

                {hasListenOption(options, "udp") && (
                    <div className={ROW}>
                        <FilledSwitch
                            label="UDP Fragment"
                            className={FIELD}
                            checked={options.udp_fragment === true}
                            onCheckedChange={(on) => setOption("udp_fragment", on)}
                        />
                        {/* Kept as the core writes it, in minutes, and never let
                            go of: cleared, it goes back to the five it started
                            at. */}
                        <FilledTextInput
                            id={udpTimeoutId}
                            label="UDP NAT expiration (minutes)"
                            className={FIELD}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={String(udpTimeoutMinutes(options.udp_timeout) ?? 5)}
                            onChange={(event) => {
                                const minutes = Number(event.target.value);

                                setOption("udp_timeout", minutes > 0 ? `${minutes}m` : "5m");
                            }}
                        />
                    </div>
                )}

                {hasListenOption(options, "keepAlive") && (
                    <div className={ROW}>
                        <FilledSwitch
                            label="Disable TCP keep alive"
                            className={FIELD}
                            checked={options.disable_tcp_keep_alive === true}
                            onCheckedChange={(on) => setOption("disable_tcp_keep_alive", on)}
                        />
                        <FilledTextInput
                            id={keepAliveId}
                            label="TCP keep alive"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            value={text("tcp_keep_alive")}
                            onChange={(event) => setOption("tcp_keep_alive", event.target.value)}
                        />
                        <FilledTextInput
                            id={keepAliveIntervalId}
                            label="TCP keep alive interval"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            value={text("tcp_keep_alive_interval")}
                            onChange={(event) =>
                                setOption("tcp_keep_alive_interval", event.target.value)
                            }
                        />
                    </div>
                )}
            </div>
        </FormSection>
    );
};

interface ListenOptionsMenuProps {
    options: Record<string, unknown>;
    disabled: boolean;
    onToggle: (option: ListenOption) => void;
}

// The reference's button that switches the groups on and off. The menu stays
// open while they are switched, as the reference's does, and Escape puts the menu
// away without the dialog it stands in.
const ListenOptionsMenu = ({ options, disabled, onToggle }: ListenOptionsMenuProps) => {
    const { anchorRef, isOpen, setIsOpen, onKeyDown } = useMenuInDialog();

    return (
        <div onKeyDown={onKeyDown}>
            <ActionMenu open={isOpen} onOpenChange={setIsOpen} anchorRef={anchorRef}>
                <ActionMenu.Anchor>
                    <Button
                        disabled={disabled}
                        className="h-9 min-w-16 rounded-[4px] border-0 bg-[var(--control-background-color-rest)] px-2 text-[14px] font-medium"
                    >
                        Listen options
                    </Button>
                </ActionMenu.Anchor>

                <ActionMenu.Overlay side="outside-left" align="center">
                    <ActionList selectionVariant="multiple">
                        {LISTEN_OPTIONS.map(({ option, label }) => (
                            <ActionList.Item
                                key={option}
                                selected={hasListenOption(options, option)}
                                onSelect={(event) => {
                                    event.preventDefault();
                                    onToggle(option);
                                }}
                            >
                                {label}
                            </ActionList.Item>
                        ))}
                    </ActionList>
                </ActionMenu.Overlay>
            </ActionMenu>
        </div>
    );
};
