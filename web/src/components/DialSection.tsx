import { ActionList, ActionMenu, Button, NativeSelect } from "@gamecrafters/base-ui/react";
import { useId } from "react";

import { useBaseConfig } from "@/features/config/api";
import { dnsOf } from "@/features/dns/api";
import { refusesAll, useOutbounds } from "@/features/outbounds/api";
import {
    DIAL_OPTIONS,
    hasDialOption,
    timeoutSeconds,
    withDialOption,
    type DialOption,
} from "@/lib/dial";
import { useMenuInDialog } from "@/lib/menu";

import { FilledSelect, FilledSwitch, FilledTextInput } from "./FilledField";
import { FormSection } from "./FormSection";

interface DialSectionProps {
    // The options of what dials, which the block reads its fields off and hands
    // back whole with them changed.
    options: Record<string, unknown>;
    onChange: (options: Record<string, unknown>) => void;
    // What dials is known by this, and is not something it can dial through.
    tag: string;
    // Held still while the options the fields are read off cannot be read.
    disabled?: boolean;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

// The reference's block for how a route out or a DNS server dials: its rows, eight
// pixels apart, each filled in as the group of options in it is switched on from
// the menu at the block's foot. Four of the rows are always there, empty until
// something in them is switched on, which is what holds the button at the foot
// as far down as the reference's.
//
// An option is kept as it is set, cleared text included, as the reference keeps
// it: a group goes from the options only when it is switched off, so a row does
// not vanish while its field is being typed over.
export const DialSection = ({ options, onChange, tag, disabled = false }: DialSectionProps) => {
    const { data: outbounds } = useOutbounds();
    const { data: config } = useBaseConfig();
    const detourId = useId();
    const bindInterfaceId = useId();
    const inet4Id = useId();
    const inet6Id = useId();
    const routingMarkId = useId();
    const keepAliveId = useId();
    const keepAliveIntervalId = useId();
    const timeoutId = useId();
    const resolverId = useId();

    // What can be dialled through: every route out but this one -- a WireGuard
    // tunnel among them -- and but a block route, which refuses whatever is
    // dialled through it. A detour switched on starts at the first of these, so
    // leaving it out is also what keeps a new one from starting there.
    const detourTags = (outbounds ?? [])
        .filter((outbound) => !refusesAll(outbound.type))
        .map((outbound) => outbound.tag)
        .filter((other) => other !== tag);
    const dnsTags = (dnsOf(config).servers ?? []).map((server) => server.tag);

    const setOption = (key: string, value: unknown) => onChange({ ...options, [key]: value });
    const toggleOption = (option: DialOption) =>
        onChange(
            withDialOption(options, option, !hasDialOption(options, option), {
                detour: detourTags[0],
                domainResolver: dnsTags[0],
            }),
        );

    const text = (key: string) => {
        const value = options[key];

        return typeof value === "string" ? value : "";
    };

    return (
        <FormSection
            title="Dial"
            actions={
                <DialOptionsMenu options={options} disabled={disabled} onToggle={toggleOption} />
            }
        >
            <div className="flex flex-col gap-2">
                <div className={ROW}>
                    {hasDialOption(options, "detour") && (
                        <FilledSelect
                            id={detourId}
                            label="Forward to outbound"
                            className={FIELD}
                            value={text("detour")}
                            onChange={(event) => setOption("detour", event.target.value)}
                        >
                            {!detourTags.includes(text("detour")) && (
                                <NativeSelect.Option value={text("detour")}>
                                    {text("detour") || "None"}
                                </NativeSelect.Option>
                            )}
                            {detourTags.map((other) => (
                                <NativeSelect.Option key={other} value={other}>
                                    {other}
                                </NativeSelect.Option>
                            ))}
                        </FilledSelect>
                    )}
                    {hasDialOption(options, "bindInterface") && (
                        <FilledTextInput
                            id={bindInterfaceId}
                            label="Bind to network interface"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            value={text("bind_interface")}
                            onChange={(event) => setOption("bind_interface", event.target.value)}
                        />
                    )}
                </div>

                <div className={ROW}>
                    {hasDialOption(options, "inet4") && (
                        <FilledTextInput
                            id={inet4Id}
                            label="Bind to IPv4"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            value={text("inet4_bind_address")}
                            onChange={(event) =>
                                setOption("inet4_bind_address", event.target.value)
                            }
                        />
                    )}
                    {hasDialOption(options, "inet6") && (
                        <FilledTextInput
                            id={inet6Id}
                            label="Bind to IPv6"
                            className={FIELD}
                            autoComplete="off"
                            spellCheck={false}
                            value={text("inet6_bind_address")}
                            onChange={(event) =>
                                setOption("inet6_bind_address", event.target.value)
                            }
                        />
                    )}
                    {hasDialOption(options, "bindNoPort") && (
                        <FilledSwitch
                            label="Bind address no port"
                            className={FIELD}
                            checked={options.bind_address_no_port === true}
                            onCheckedChange={(on) => setOption("bind_address_no_port", on)}
                        />
                    )}
                </div>

                <div className={ROW}>
                    {/* Never less than nothing, and cleared it is nothing, as the
                        reference keeps it. */}
                    {hasDialOption(options, "routingMark") && (
                        <FilledTextInput
                            id={routingMarkId}
                            label="Linux routing mark"
                            className={FIELD}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            value={String(
                                typeof options.routing_mark === "number" ? options.routing_mark : 0,
                            )}
                            onChange={(event) =>
                                setOption(
                                    "routing_mark",
                                    Math.max(Math.trunc(Number(event.target.value)) || 0, 0),
                                )
                            }
                        />
                    )}
                    {hasDialOption(options, "reuseAddr") && (
                        <FilledSwitch
                            label="Reuse listener address"
                            className={FIELD}
                            checked={options.reuse_addr === true}
                            onCheckedChange={(on) => setOption("reuse_addr", on)}
                        />
                    )}
                </div>

                {hasDialOption(options, "tcp") && (
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

                {hasDialOption(options, "keepAlive") && (
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

                <div className={ROW}>
                    {hasDialOption(options, "udp") && (
                        <FilledSwitch
                            label="UDP Fragment"
                            className={FIELD}
                            checked={options.udp_fragment === true}
                            onCheckedChange={(on) => setOption("udp_fragment", on)}
                        />
                    )}
                    {/* Kept as the core writes it, in seconds, and never let go
                        of: cleared, it goes back to the five it started at. */}
                    {hasDialOption(options, "connectTimeout") && (
                        <FilledTextInput
                            id={timeoutId}
                            label="Connection timeout (seconds)"
                            className={FIELD}
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={String(timeoutSeconds(options.connect_timeout) ?? 5)}
                            onChange={(event) => {
                                const seconds = Number(event.target.value);

                                setOption("connect_timeout", seconds > 0 ? `${seconds}s` : "5s");
                            }}
                        />
                    )}
                </div>

                {hasDialOption(options, "domainResolver") && (
                    <div className={ROW}>
                        <FilledSelect
                            id={resolverId}
                            label="Domain resolver"
                            className={FIELD}
                            value={text("domain_resolver")}
                            onChange={(event) => setOption("domain_resolver", event.target.value)}
                        >
                            {!dnsTags.includes(text("domain_resolver")) && (
                                <NativeSelect.Option value={text("domain_resolver")}>
                                    {text("domain_resolver") || "None"}
                                </NativeSelect.Option>
                            )}
                            {dnsTags.map((server) => (
                                <NativeSelect.Option key={server} value={server}>
                                    {server}
                                </NativeSelect.Option>
                            ))}
                        </FilledSelect>
                    </div>
                )}
            </div>
        </FormSection>
    );
};

interface DialOptionsMenuProps {
    options: Record<string, unknown>;
    disabled: boolean;
    onToggle: (option: DialOption) => void;
}

// The reference's button that switches the groups on and off. The menu stays
// open while they are switched, as the reference's does, and Escape puts the menu
// away without the dialog it stands in.
const DialOptionsMenu = ({ options, disabled, onToggle }: DialOptionsMenuProps) => {
    const { anchorRef, isOpen, setIsOpen, onKeyDown } = useMenuInDialog();

    return (
        <div onKeyDown={onKeyDown}>
            <ActionMenu open={isOpen} onOpenChange={setIsOpen} anchorRef={anchorRef}>
                <ActionMenu.Anchor>
                    <Button
                        disabled={disabled}
                        className="h-9 min-w-16 rounded-[4px] border-0 bg-[var(--control-background-color-rest)] px-2 text-[14px] font-medium"
                    >
                        Dial options
                    </Button>
                </ActionMenu.Anchor>

                <ActionMenu.Overlay side="outside-left" align="center">
                    <ActionList selectionVariant="multiple">
                        {DIAL_OPTIONS.map(({ option, label }) => (
                            <ActionList.Item
                                key={option}
                                selected={hasDialOption(options, option)}
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
