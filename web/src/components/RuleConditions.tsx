import { ActionList, ActionMenu, Button, NativeSelect } from "@gamecrafters/base-ui/react";
import { useId } from "react";

import { useInboundClients, useInbounds } from "@/features/inbounds/api";
import { useMenuInDialog } from "@/lib/menu";
import {
    CONDITION_GROUPS,
    CONDITION_KEY_LABELS,
    CONDITION_LABELS,
    conditionChoices,
    conditionKey,
    hasCondition,
    isSwitchKey,
    listFor,
    withCondition,
    withConditionKey,
    type ConditionGroup,
    type CoreRule,
    type RuleKind,
} from "@/lib/rules";

import { FilledListField, FilledMultiSelect, FilledSelect, FilledSwitch } from "./FilledField";
import { FormSection } from "./FormSection";

interface RuleConditionsProps {
    kind: RuleKind;
    // What the rule matches, which the block reads its fields off and hands
    // back whole with them changed.
    conditions: CoreRule;
    onChange: (conditions: CoreRule) => void;
    // What the rule can name: the rule sets, and the routes out a connection
    // can be preferred by.
    ruleSetTags: string[];
    outboundTags?: string[];
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up; a half one a half from a tablet up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";
const HALF = "col-span-12 min-[600px]:col-span-6";
const WHOLE = "col-span-12";

// What the core can tell a connection's protocol as, by the names the reference
// gives them. A DNS query is told as fewer.
const PROTOCOLS: Record<RuleKind, { value: string; label: string }[]> = {
    route: [
        { value: "http", label: "HTTP" },
        { value: "tls", label: "TLS" },
        { value: "quic", label: "QUIC" },
        { value: "stun", label: "STUN" },
        { value: "dns", label: "DNS" },
        { value: "bittorrent", label: "BitTorrent" },
        { value: "dtls", label: "DTLS" },
        { value: "ssh", label: "SSH" },
        { value: "rdp", label: "RDP" },
        { value: "ntp", label: "NTP" },
    ],
    dns: [
        { value: "http", label: "http" },
        { value: "tls", label: "tls" },
        { value: "quic", label: "quic" },
        { value: "stun", label: "stun" },
        { value: "dns", label: "dns" },
    ],
};

const NETWORKS = ["tcp", "udp", "icmp"];

// The choices a list can be made of, with whatever it already holds that is no
// longer among them kept, so an edit does not drop it unseen.
const choicesOf = (known: string[], value: unknown) =>
    [...new Set([...known, ...(Array.isArray(value) ? value.map(String) : [])])].map((choice) => ({
        value: choice,
        label: choice,
    }));

const listOf = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

// The reference's block of what a rule matches: a row for each group of
// conditions switched on from the menu at its foot, the first always there and
// empty until something in it is. A group of several keys matches on one of them
// at a time, chosen from a list, with the entries beside it -- a line to an
// entry for a route rule, as the reference types them, and a comma to one for a
// DNS rule.
export const RuleConditions = ({
    kind,
    conditions,
    onChange,
    ruleSetTags,
    outboundTags = [],
}: RuleConditionsProps) => {
    const { data: inbounds } = useInbounds();
    const { data: clients } = useInboundClients();
    const inboundId = useId();
    const clientId = useId();
    const ipVersionId = useId();
    const networkId = useId();
    const protocolId = useId();
    const preferredById = useId();
    const ruleSetId = useId();
    const fieldIds = useId();

    const inboundTags = (inbounds ?? []).map((inbound) => inbound.tag);
    const clientNames = (clients?.clients ?? []).map((client) => client.name);
    const separator = kind === "route" ? "\n" : ",";

    const set = (key: string, value: unknown) => onChange({ ...conditions, [key]: value });
    const has = (group: ConditionGroup) => hasCondition(conditions, group);

    // A group of several keys: which one it matches on, and what.
    const chosen = (group: ConditionGroup) => {
        const key = conditionKey(conditions, group);

        return (
            <div className={ROW}>
                <FilledSelect
                    id={`${fieldIds}-${group}`}
                    label={CONDITION_LABELS[group]}
                    className={FIELD}
                    value={key}
                    onChange={(event) =>
                        onChange(withConditionKey(conditions, group, event.target.value))
                    }
                >
                    {conditionChoices(group, kind).map((choice) => (
                        <NativeSelect.Option key={choice} value={choice}>
                            {CONDITION_KEY_LABELS[choice]}
                        </NativeSelect.Option>
                    ))}
                </FilledSelect>

                {isSwitchKey(key) ? (
                    <FilledSwitch
                        label={CONDITION_KEY_LABELS[key]}
                        className={HALF}
                        checked={conditions[key] === true}
                        onCheckedChange={(on) => set(key, on)}
                    />
                ) : (
                    // Keyed by what it lists, so another key starts it afresh.
                    <FilledListField
                        key={key}
                        id={`${fieldIds}-${key}`}
                        label={`${CONDITION_KEY_LABELS[key]}${separator === "," ? " (comma separated)" : ""}`}
                        className={HALF}
                        separator={separator}
                        value={conditions[key]}
                        onChange={(entries) => set(key, listFor(key, entries))}
                    />
                )}
            </div>
        );
    };

    return (
        <FormSection
            label="Conditions"
            hasSpacedActions
            actions={
                <ConditionsMenu
                    kind={kind}
                    conditions={conditions}
                    onToggle={(group) =>
                        onChange(withCondition(conditions, group, !has(group), kind))
                    }
                />
            }
        >
            <div className="flex flex-col gap-2">
                <div className={ROW}>
                    {has("inbound") && (
                        <FilledMultiSelect
                            id={inboundId}
                            label="Inbounds"
                            className={WHOLE}
                            options={choicesOf(inboundTags, conditions.inbound)}
                            value={listOf(conditions.inbound)}
                            onChange={(tags) => set("inbound", tags)}
                        />
                    )}
                    {has("client") && (
                        <FilledMultiSelect
                            id={clientId}
                            label="Clients"
                            className={WHOLE}
                            options={choicesOf(clientNames, conditions.auth_user)}
                            value={listOf(conditions.auth_user)}
                            onChange={(names) => set("auth_user", names)}
                        />
                    )}
                    {has("ipVersion") && (
                        <FilledSelect
                            id={ipVersionId}
                            label="IP version"
                            className={FIELD}
                            value={String(conditions.ip_version)}
                            onChange={(event) => set("ip_version", Number(event.target.value))}
                        >
                            <NativeSelect.Option value="4">4</NativeSelect.Option>
                            <NativeSelect.Option value="6">6</NativeSelect.Option>
                        </FilledSelect>
                    )}
                    {has("network") && (
                        <FilledMultiSelect
                            id={networkId}
                            label="Network"
                            className={FIELD}
                            options={choicesOf(NETWORKS, conditions.network)}
                            value={listOf(conditions.network)}
                            onChange={(networks) => set("network", networks)}
                        />
                    )}
                    {has("protocol") && (
                        <FilledMultiSelect
                            id={protocolId}
                            label="Protocol"
                            className={HALF}
                            options={[
                                ...PROTOCOLS[kind],
                                ...choicesOf([], conditions.protocol).filter(
                                    (choice) =>
                                        !PROTOCOLS[kind].some(
                                            (known) => known.value === choice.value,
                                        ),
                                ),
                            ]}
                            value={listOf(conditions.protocol)}
                            onChange={(protocols) => set("protocol", protocols)}
                        />
                    )}
                </div>

                {has("domain") && chosen("domain")}
                {has("port") && chosen("port")}
                {has("sourceIp") && chosen("sourceIp")}
                {has("sourcePort") && chosen("sourcePort")}

                {has("preferredBy") && (
                    <div className={ROW}>
                        <FilledMultiSelect
                            id={preferredById}
                            label="Preferred by (outbound)"
                            className={HALF}
                            options={choicesOf(outboundTags, conditions.preferred_by)}
                            value={listOf(conditions.preferred_by)}
                            onChange={(tags) => set("preferred_by", tags)}
                        />
                    </div>
                )}

                {has("interface") && chosen("interface")}

                {has("ruleSet") && (
                    <div className={ROW}>
                        <FilledMultiSelect
                            id={ruleSetId}
                            label="Rule sets"
                            className={HALF}
                            options={choicesOf(ruleSetTags, conditions.rule_set)}
                            value={listOf(conditions.rule_set)}
                            onChange={(tags) => set("rule_set", tags)}
                        />
                        {kind === "route" && (
                            <FilledSwitch
                                label="Rule set IP CIDR match source"
                                className={HALF}
                                checked={conditions.rule_set_ip_cidr_match_source === true}
                                onCheckedChange={(on) => set("rule_set_ip_cidr_match_source", on)}
                            />
                        )}
                    </div>
                )}
            </div>
        </FormSection>
    );
};

interface ConditionsMenuProps {
    kind: RuleKind;
    conditions: CoreRule;
    onToggle: (group: ConditionGroup) => void;
}

// The reference's button that switches the groups on and off. The menu stays
// open while they are switched, as the reference's does, and Escape puts the menu
// away without the dialog it stands in.
const ConditionsMenu = ({ kind, conditions, onToggle }: ConditionsMenuProps) => {
    const { anchorRef, isOpen, setIsOpen, onKeyDown } = useMenuInDialog();

    return (
        <div onKeyDown={onKeyDown}>
            <ActionMenu open={isOpen} onOpenChange={setIsOpen} anchorRef={anchorRef}>
                <ActionMenu.Anchor>
                    <Button className="h-9 min-w-16 rounded-[4px] border-0 bg-[var(--control-background-color-rest)] px-2 text-[14px] font-medium">
                        Rule options
                    </Button>
                </ActionMenu.Anchor>

                <ActionMenu.Overlay side="outside-left" align="center">
                    <ActionList selectionVariant="multiple">
                        {CONDITION_GROUPS[kind].map((group) => (
                            <ActionList.Item
                                key={group}
                                selected={hasCondition(conditions, group)}
                                onSelect={(event) => {
                                    event.preventDefault();
                                    onToggle(group);
                                }}
                            >
                                {CONDITION_LABELS[group]}
                            </ActionList.Item>
                        ))}
                    </ActionList>
                </ActionMenu.Overlay>
            </ActionMenu>
        </div>
    );
};
