import { NativeSelect } from "@gamecrafters/base-ui/react";
import { useId, useState, type FormEvent, type RefObject } from "react";

import {
    FilledListField,
    FilledSelect,
    FilledSwitch,
    FilledTextInput,
} from "@/components/FilledField";
import { FormDialog } from "@/components/FormDialog";
import { FormSection } from "@/components/FormSection";
import { RuleFields } from "@/components/RuleFields";
import { RESOLVE_STRATEGIES } from "@/features/rules/api";
import type { RuleDraft } from "@/lib/rules";

import {
    DNS_RCODES,
    DNS_RULE_ACTIONS,
    DNS_RULE_DOCS,
    fromDnsRuleDraft,
    newDnsRuleDraft,
    toDnsRuleDraft,
    type DnsRule,
} from "../api";

interface DnsRuleDialogProps {
    // The rule being amended, or none for a new one.
    rule?: DnsRule;
    // The tags of the servers a rule that routes can send a query to, and of
    // the rule sets it can match on.
    serverTags: string[];
    ruleSetTags: string[];
    onSave: (rule: DnsRule) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up; a wide one two thirds from a tablet
// up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";
const WIDE = "col-span-12 min-[600px]:col-span-8";

// A rule written into the page, for the reason a server is: the page's own Save
// writes the document it belongs to. What every rule has is laid out by the
// fields both kinds share; under them is the reference's block for what the
// action takes.
export const DnsRuleDialog = ({
    rule,
    serverTags,
    ruleSetTags,
    onSave,
    onClose,
    returnFocusRef,
}: DnsRuleDialogProps) => {
    const formId = useId();
    const serverId = useId();
    const strategyId = useId();
    const rewriteTtlId = useId();
    const clientSubnetId = useId();
    const methodId = useId();
    const rcodeId = useId();
    const answerId = useId();
    const nsId = useId();
    const extraId = useId();

    const [draft, setDraft] = useState<RuleDraft>(() =>
        rule ? toDnsRuleDraft(rule) : newDnsRuleDraft(serverTags[0] ?? ""),
    );
    const [serverError, setServerError] = useState<string>();

    const { action } = draft;
    const name = typeof action.action === "string" ? action.action : "route";
    const text = (key: string) => (typeof action[key] === "string" ? action[key] : "");
    const setAction = (key: string, value: unknown) =>
        setDraft({ ...draft, action: { ...action, [key]: value } });

    // A rule that routes has to say where to. The core would refuse one that
    // did not when the node started, which is later than the form.
    const onSubmit = (event: FormEvent) => {
        event.preventDefault();

        if (name === "route" && !text("server")) {
            setServerError("Choose a server.");
            return;
        }

        onSave(fromDnsRuleDraft(draft));
    };

    const list = (id: string, label: string, key: string) => (
        <FilledListField
            id={id}
            label={`${label} (comma separated)`}
            className={WIDE}
            separator=","
            value={action[key]}
            onChange={(entries) => setAction(key, entries)}
        />
    );

    return (
        <FormDialog
            title={rule ? "Edit DNS rule" : "Add DNS rule"}
            docs={DNS_RULE_DOCS}
            formId={formId}
            isSaving={false}
            onClose={onClose}
            returnFocusRef={returnFocusRef}
        >
            <form id={formId} onSubmit={onSubmit} noValidate>
                <RuleFields
                    kind="dns"
                    draft={draft}
                    onChange={setDraft}
                    actions={DNS_RULE_ACTIONS}
                    ruleSetTags={ruleSetTags}
                />

                {/* A rule that routes says to which server; one that only sets
                    options for the query has the rest without it. */}
                {(name === "route" || name === "route-options") && (
                    <FormSection title="Route">
                        <div className="flex flex-col gap-2">
                            {name === "route" && (
                                <div className={ROW}>
                                    <FilledSelect
                                        id={serverId}
                                        label="Server"
                                        className={FIELD}
                                        validation={serverError}
                                        value={text("server")}
                                        onChange={(event) => {
                                            setServerError(undefined);
                                            setAction("server", event.target.value);
                                        }}
                                    >
                                        {!text("server") && (
                                            <NativeSelect.Option value="">
                                                Choose a server
                                            </NativeSelect.Option>
                                        )}
                                        {serverTags.map((tag) => (
                                            <NativeSelect.Option key={tag} value={tag}>
                                                {tag}
                                            </NativeSelect.Option>
                                        ))}
                                        {/* A server deleted out from under the
                                            rule would otherwise land on the
                                            first one and be saved that way by an
                                            edit that never touched it. */}
                                        {text("server") && !serverTags.includes(text("server")) && (
                                            <NativeSelect.Option value={text("server")}>
                                                {text("server")} — no longer exists
                                            </NativeSelect.Option>
                                        )}
                                    </FilledSelect>
                                    <FilledSelect
                                        id={strategyId}
                                        label="Strategy"
                                        className={FIELD}
                                        value={text("strategy")}
                                        onChange={(event) =>
                                            setAction("strategy", event.target.value)
                                        }
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
                                </div>
                            )}
                            <div className={ROW}>
                                <FilledSwitch
                                    label="Disable cache"
                                    className={FIELD}
                                    checked={action.disable_cache === true}
                                    onCheckedChange={(on) => setAction("disable_cache", on)}
                                />
                                <FilledTextInput
                                    id={rewriteTtlId}
                                    label="Rewrite TTL"
                                    className={FIELD}
                                    type="number"
                                    inputMode="numeric"
                                    min={0}
                                    value={
                                        typeof action.rewrite_ttl === "number"
                                            ? String(action.rewrite_ttl)
                                            : ""
                                    }
                                    onChange={(event) =>
                                        setAction("rewrite_ttl", Number(event.target.value) || 0)
                                    }
                                />
                                <FilledTextInput
                                    id={clientSubnetId}
                                    label="Client subnet"
                                    className={FIELD}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={text("client_subnet")}
                                    onChange={(event) =>
                                        setAction("client_subnet", event.target.value)
                                    }
                                />
                            </div>
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

                {/* Records to answer with are only an answer that is not an
                    error. */}
                {name === "predefined" && (
                    <FormSection title="Predefined">
                        <div className="flex flex-col gap-2">
                            <div className={ROW}>
                                <FilledSelect
                                    id={rcodeId}
                                    label="Response code"
                                    className={FIELD}
                                    value={text("rcode")}
                                    onChange={(event) => setAction("rcode", event.target.value)}
                                >
                                    <NativeSelect.Option value="">None</NativeSelect.Option>
                                    {DNS_RCODES.map((rcode) => (
                                        <NativeSelect.Option key={rcode.value} value={rcode.value}>
                                            {rcode.label}
                                        </NativeSelect.Option>
                                    ))}
                                </FilledSelect>
                            </div>
                            {text("rcode") === "NOERROR" && (
                                <div className={ROW}>
                                    {list(answerId, "Answers", "answer")}
                                    {list(nsId, "Nameservers", "ns")}
                                    {list(extraId, "Extra", "extra")}
                                </div>
                            )}
                        </div>
                    </FormSection>
                )}
            </form>
        </FormDialog>
    );
};
