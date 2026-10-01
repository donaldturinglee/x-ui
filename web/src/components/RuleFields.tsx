import { Button, IconButton, NativeSelect } from "@gamecrafters/base-ui/react";
import { DeleteRegular } from "@gamecrafters/base-ui-icons";
import { useId } from "react";

import type { CoreRule, RuleDraft, RuleKind } from "@/lib/rules";

import { FilledSelect, FilledSwitch } from "./FilledField";
import { FormSection } from "./FormSection";
import { RuleConditions } from "./RuleConditions";

interface RuleFieldsProps {
    kind: RuleKind;
    draft: RuleDraft;
    onChange: (draft: RuleDraft) => void;
    // What a rule of the kind can do, and what it can name.
    actions: { value: string; label: string }[];
    ruleSetTags: string[];
    outboundTags?: string[];
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

// What a route rule and a DNS rule have in common, laid out as the reference
// lays both out: whether the rule combines others, what it -- or each rule it
// combines -- matches, and what it does, whether it combines them with and or
// or, and whether it is inverted. What the action takes is the dialog's own, and
// stands under these.
export const RuleFields = ({
    kind,
    draft,
    onChange,
    actions,
    ruleSetTags,
    outboundTags,
}: RuleFieldsProps) => {
    const actionId = useId();
    const modeId = useId();

    const action = typeof draft.action.action === "string" ? draft.action.action : "route";

    const change = (changes: Partial<RuleDraft>) => onChange({ ...draft, ...changes });
    const setRule = (index: number, conditions: CoreRule) =>
        change({ rules: draft.rules.map((current, at) => (at === index ? conditions : current)) });

    return (
        <>
            <div className={`${ROW} items-center`}>
                {/* A rule that combines others starts with the one it has. */}
                <FilledSwitch
                    label="Logical"
                    className={FIELD}
                    checked={draft.logical}
                    onCheckedChange={(logical) => change({ logical })}
                />
                {/* Keep the logical rule's Add button at the end of the row. */}
                {draft.logical && (
                    <div className="col-span-12 flex justify-end self-start min-[600px]:col-span-6 min-[840px]:col-span-4 min-[840px]:col-start-9">
                        <Button
                            variant="primary"
                            className="h-9 min-w-16 rounded-[4px] px-4 text-[14px] font-medium shadow-[var(--shadow-resting-small)]"
                            onClick={() => change({ rules: [...draft.rules, {}] })}
                        >
                            Add rule
                        </Button>
                    </div>
                )}
            </div>

            {/* Each rule it combines in a block of its own headed flush, five
                pixels under the one before and over what follows, as the
                reference's are. */}
            {draft.logical ? (
                <div className="flex flex-col gap-[5px] pb-[5px]">
                    {draft.rules.map((conditions, index) => (
                        <FormSection
                            key={index}
                            title={`Rule ${index + 1}`}
                            hasFlushTitle
                            titleAction={
                                draft.rules.length > 1 && (
                                    <IconButton
                                        icon={<DeleteRegular size={16} />}
                                        aria-label={`Delete rule ${index + 1}`}
                                        variant="invisible"
                                        className="inline-flex size-[21px] min-w-0 p-0 align-middle text-[var(--foreground-color-muted)]"
                                        onClick={() =>
                                            change({
                                                rules: draft.rules.filter((_, at) => at !== index),
                                            })
                                        }
                                    />
                                )
                            }
                        >
                            <RuleConditions
                                kind={kind}
                                conditions={conditions}
                                onChange={(next) => setRule(index, next)}
                                ruleSetTags={ruleSetTags}
                                outboundTags={outboundTags}
                            />
                        </FormSection>
                    ))}
                </div>
            ) : (
                <RuleConditions
                    kind={kind}
                    conditions={draft.rules[0] ?? {}}
                    onChange={(next) => setRule(0, next)}
                    ruleSetTags={ruleSetTags}
                    outboundTags={outboundTags}
                />
            )}

            <div className={`${ROW} items-center`}>
                <FilledSelect
                    id={actionId}
                    label="Action"
                    className={FIELD}
                    value={action}
                    onChange={(event) =>
                        change({ action: { ...draft.action, action: event.target.value } })
                    }
                >
                    {actions.map((choice) => (
                        <NativeSelect.Option key={choice.value} value={choice.value}>
                            {choice.label}
                        </NativeSelect.Option>
                    ))}
                    {!actions.some((choice) => choice.value === action) && (
                        <NativeSelect.Option value={action}>
                            {action} — not one this panel knows
                        </NativeSelect.Option>
                    )}
                </FilledSelect>
                {draft.logical && (
                    <FilledSelect
                        id={modeId}
                        label="Mode"
                        className={FIELD}
                        value={draft.mode}
                        onChange={(event) => change({ mode: event.target.value })}
                    >
                        <NativeSelect.Option value="and">and</NativeSelect.Option>
                        <NativeSelect.Option value="or">or</NativeSelect.Option>
                    </FilledSelect>
                )}
                <FilledSwitch
                    label="Invert"
                    className={FIELD}
                    checked={draft.action.invert === true}
                    onCheckedChange={(invert) => change({ action: { ...draft.action, invert } })}
                />
            </div>
        </>
    );
};
