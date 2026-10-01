import { NativeSelect } from "@gamecrafters/base-ui/react";
import { useId, useState, type FormEvent, type RefObject } from "react";

import {
    FilledMultiSelect,
    FilledSelect,
    FilledSwitch,
    FilledTextInput,
} from "@/components/FilledField";
import { FormDialog } from "@/components/FormDialog";
import { FormSection } from "@/components/FormSection";
import { RuleFields } from "@/components/RuleFields";

import {
    fromRuleDraft,
    newRuleDraft,
    RESOLVE_STRATEGIES,
    RULE_ACTIONS,
    SNIFFERS,
    toRuleDraft,
    type RouteRule,
    type RuleDraft,
} from "../api";

interface RuleDialogProps {
    // The rule being amended, or none for a new one.
    rule?: RouteRule;
    // The routes out a rule that routes can send a connection to, and the rule
    // sets it can match on.
    outboundTags: string[];
    ruleSetTags: string[];
    onSave: (rule: RouteRule) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

// Where the proxy core documents route rules, as the mark in the title leads to
// it.
const RULE_DOCS = {
    href: "https://sing-box.sagernet.org/configuration/route/rule/",
    label: "Route rule",
};

// A routing rule written into the page, which the page's own Save writes into
// the document it belongs to, as a DNS rule is. What every rule has is laid out
// by the fields both kinds share; under them is the reference's block for what
// the action takes, where it takes anything.
//
// The rule is held whole while it is edited rather than field by field, since
// what it matches is a list of rules as often as it is one.
export const RuleDialog = ({
    rule,
    outboundTags,
    ruleSetTags,
    onSave,
    onClose,
    returnFocusRef,
}: RuleDialogProps) => {
    const formId = useId();
    const outboundId = useId();
    const overrideAddressId = useId();
    const overridePortId = useId();
    const udpTimeoutId = useId();
    const methodId = useId();
    const snifferId = useId();
    const sniffTimeoutId = useId();
    const strategyId = useId();
    const serverId = useId();

    const [draft, setDraft] = useState<RuleDraft>(() =>
        rule ? toRuleDraft(rule) : newRuleDraft(outboundTags[0] ?? ""),
    );
    const [outboundError, setOutboundError] = useState<string>();

    const { action } = draft;
    const name = typeof action.action === "string" ? action.action : "route";
    const text = (key: string) => (typeof action[key] === "string" ? action[key] : "");
    const setAction = (key: string, value: unknown) =>
        setDraft({ ...draft, action: { ...action, [key]: value } });

    // A rule that routes has to say where to; the core would refuse one that did
    // not when the node started, which is later than the form.
    const onSubmit = (event: FormEvent) => {
        event.preventDefault();

        if (name === "route" && !text("outbound")) {
            setOutboundError("Choose a route out.");
            return;
        }

        onSave(fromRuleDraft(draft));
    };

    return (
        <FormDialog
            title={rule ? "Edit rule" : "Add rule"}
            docs={RULE_DOCS}
            formId={formId}
            isSaving={false}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                <RuleFields
                    kind="route"
                    draft={draft}
                    onChange={setDraft}
                    actions={RULE_ACTIONS}
                    ruleSetTags={ruleSetTags}
                    outboundTags={outboundTags}
                />

                {name === "route" && (
                    <FormSection title="Route">
                        <div className={ROW}>
                            <FilledSelect
                                id={outboundId}
                                label="Outbound"
                                className={FIELD}
                                validation={outboundError}
                                value={text("outbound")}
                                onChange={(event) => {
                                    setOutboundError(undefined);
                                    setAction("outbound", event.target.value);
                                }}
                            >
                                {!text("outbound") && (
                                    <NativeSelect.Option value="">
                                        Choose a route out
                                    </NativeSelect.Option>
                                )}
                                {outboundTags.map((tag) => (
                                    <NativeSelect.Option key={tag} value={tag}>
                                        {tag}
                                    </NativeSelect.Option>
                                ))}
                                {/* One deleted out from under the rule would
                                    otherwise land on the first and be saved that
                                    way by an edit that never touched it. */}
                                {text("outbound") && !outboundTags.includes(text("outbound")) && (
                                    <NativeSelect.Option value={text("outbound")}>
                                        {text("outbound")} — no longer exists
                                    </NativeSelect.Option>
                                )}
                            </FilledSelect>
                        </div>
                    </FormSection>
                )}

                {name === "route-options" && (
                    <FormSection title="Route options">
                        <div className={ROW}>
                            <FilledTextInput
                                id={overrideAddressId}
                                label="Override address"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                value={text("override_address")}
                                onChange={(event) =>
                                    setAction("override_address", event.target.value)
                                }
                            />
                            <FilledTextInput
                                id={overridePortId}
                                label="Override port"
                                className={FIELD}
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={65535}
                                value={
                                    typeof action.override_port === "number"
                                        ? String(action.override_port)
                                        : ""
                                }
                                onChange={(event) =>
                                    setAction("override_port", Number(event.target.value) || 0)
                                }
                            />
                            <FilledSwitch
                                label="UDP disable domain unmapping"
                                className={FIELD}
                                checked={action.udp_disable_domain_unmapping === true}
                                onCheckedChange={(on) =>
                                    setAction("udp_disable_domain_unmapping", on)
                                }
                            />
                            <FilledSwitch
                                label="UDP connect"
                                className={FIELD}
                                checked={action.udp_connect === true}
                                onCheckedChange={(on) => setAction("udp_connect", on)}
                            />
                            <FilledTextInput
                                id={udpTimeoutId}
                                label="UDP timeout"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                value={text("udp_timeout")}
                                onChange={(event) => setAction("udp_timeout", event.target.value)}
                            />
                        </div>
                    </FormSection>
                )}

                {name === "reject" && (
                    <FormSection title="Reject">
                        <div className={ROW}>
                            <FilledSelect
                                id={methodId}
                                label="Method"
                                className={FIELD}
                                value={text("method")}
                                onChange={(event) => setAction("method", event.target.value)}
                            >
                                <NativeSelect.Option value="">None</NativeSelect.Option>
                                <NativeSelect.Option value="default">Default</NativeSelect.Option>
                                <NativeSelect.Option value="drop">Drop</NativeSelect.Option>
                            </FilledSelect>
                            <FilledSwitch
                                label="No drop"
                                className={FIELD}
                                checked={action.no_drop === true}
                                onCheckedChange={(on) => setAction("no_drop", on)}
                            />
                        </div>
                    </FormSection>
                )}

                {name === "sniff" && (
                    <FormSection title="Sniff">
                        <div className={ROW}>
                            <FilledMultiSelect
                                id={snifferId}
                                label="Sniffer"
                                className={FIELD}
                                options={SNIFFERS}
                                value={
                                    Array.isArray(action.sniffer) ? action.sniffer.map(String) : []
                                }
                                onChange={(sniffers) => setAction("sniffer", sniffers)}
                            />
                            <FilledTextInput
                                id={sniffTimeoutId}
                                label="Timeout"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                value={text("timeout")}
                                onChange={(event) => setAction("timeout", event.target.value)}
                            />
                        </div>
                    </FormSection>
                )}

                {name === "resolve" && (
                    <FormSection title="Resolve">
                        <div className={ROW}>
                            <FilledSelect
                                id={strategyId}
                                label="Strategy"
                                className={FIELD}
                                value={text("strategy")}
                                onChange={(event) => setAction("strategy", event.target.value)}
                            >
                                <NativeSelect.Option value="">None</NativeSelect.Option>
                                {RESOLVE_STRATEGIES.map((strategy) => (
                                    <NativeSelect.Option
                                        key={strategy.value}
                                        value={strategy.value}
                                    >
                                        {strategy.label}
                                    </NativeSelect.Option>
                                ))}
                            </FilledSelect>
                            <FilledTextInput
                                id={serverId}
                                label="DNS server"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                value={text("server")}
                                onChange={(event) => setAction("server", event.target.value)}
                            />
                        </div>
                    </FormSection>
                )}
            </form>
        </FormDialog>
    );
};
