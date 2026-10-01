import {
    Checkbox,
    CheckboxGroup,
    Dialog,
    FormControl,
    NativeSelect,
    NumberInput,
    Stack,
} from "@gamecrafters/base-ui/react";
import { useId, useState, type RefObject } from "react";

import type { Outbound } from "@/features/outbounds/api";

import {
    isPlainDirect,
    remoteRuleSet,
    RULE_SET_CATALOG,
    type RouteRule,
    type RuleSet,
} from "../api";

interface PresetRuleSetsDialogProps {
    // The tags the rule sets already have. A preset under one of them is not
    // added again, but can still be routed by the rule this adds.
    takenTags: string[];
    outboundTags: string[];
    outbounds: Outbound[];
    onImport: (ruleSets: RuleSet[], rule: RouteRule | null) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// The rule sets the reference offers ready-made -- the sites and addresses most
// often routed on their own -- picked from a list, with a rule sending them all
// to one route out if that is what they are wanted for.
export const PresetRuleSetsDialog = ({
    takenTags,
    outboundTags,
    outbounds,
    onImport,
    onClose,
    returnFocusRef,
}: PresetRuleSetsDialogProps) => {
    const listId = useId();
    const detourId = useId();
    const daysId = useId();
    const addRuleId = useId();
    const routeToId = useId();

    const [selected, setSelected] = useState<string[]>([]);
    const [detour, setDetour] = useState("");
    const [days, setDays] = useState(1);
    const [addRule, setAddRule] = useState(false);
    const [routeTo, setRouteTo] = useState(outboundTags[0] ?? "");

    const picked = RULE_SET_CATALOG.filter(({ tag }) => selected.includes(tag));
    const fresh = picked.filter(({ tag }) => !takenTags.includes(tag));
    const rule =
        addRule && routeTo && picked.length > 0
            ? { rule_set: picked.map(({ tag }) => tag), action: "route", outbound: routeTo }
            : null;

    // A plain direct route out is what no detour already means, and the core
    // refuses a detour that changes nothing, so it is written as none.
    const via = isPlainDirect(outbounds.find((outbound) => outbound.tag === detour))
        ? undefined
        : detour || undefined;

    const toggle = (tag: string, isOn: boolean) =>
        setSelected((current) =>
            isOn ? [...current, tag] : current.filter((other) => other !== tag),
        );

    return (
        <Dialog
            title="Preset rule sets"
            subtitle="Kept on the page until it is saved."
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="large"
            footerButtons={[
                { content: "Cancel", onClick: onClose },
                {
                    content: "Add",
                    buttonType: "primary",
                    disabled: fresh.length === 0 && !rule,
                    onClick: () =>
                        onImport(
                            fresh.map(({ tag, url }) =>
                                remoteRuleSet({ tag, url, format: "binary", detour: via, days }),
                            ),
                            rule,
                        ),
                },
            ]}
        >
            <Stack gap="normal">
                <CheckboxGroup aria-labelledby={listId}>
                    <CheckboxGroup.Label id={listId}>Rule sets</CheckboxGroup.Label>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-1 min-[600px]:grid-cols-3">
                        {RULE_SET_CATALOG.map(({ tag, name }) => (
                            <FormControl key={tag} id={`${listId}-${tag}`}>
                                <Checkbox
                                    id={`${listId}-${tag}`}
                                    value={tag}
                                    checked={selected.includes(tag)}
                                    onChange={(event) => toggle(tag, event.target.checked)}
                                />
                                {/* One the page already has is said to be there,
                                    since picking it only puts it in the rule. */}
                                <FormControl.Label>
                                    {name}
                                    {takenTags.includes(tag) && " (already added)"}
                                </FormControl.Label>
                            </FormControl>
                        ))}
                    </div>
                </CheckboxGroup>

                <Stack direction="horizontal" gap="normal" wrap="wrap">
                    <Stack.Item grow className="min-w-40 basis-0">
                        <FormControl id={detourId}>
                            <FormControl.Label>Outbound</FormControl.Label>
                            <NativeSelect
                                id={detourId}
                                block
                                value={detour}
                                onChange={(event) => setDetour(event.target.value)}
                            >
                                <NativeSelect.Option value="">Default</NativeSelect.Option>
                                {outboundTags.map((tag) => (
                                    <NativeSelect.Option key={tag} value={tag}>
                                        {tag}
                                    </NativeSelect.Option>
                                ))}
                            </NativeSelect>
                            <FormControl.Caption>
                                What they are downloaded through.
                            </FormControl.Caption>
                        </FormControl>
                    </Stack.Item>

                    <Stack.Item grow className="min-w-40 basis-0">
                        <FormControl id={daysId}>
                            <FormControl.Label>Update every (days)</FormControl.Label>
                            <NumberInput
                                id={daysId}
                                block
                                min={0}
                                value={days}
                                onChange={(value) => setDays(value ?? 0)}
                            />
                        </FormControl>
                    </Stack.Item>
                </Stack>

                <FormControl id={addRuleId}>
                    <FormControl.Label>Add a rule sending them to one route out</FormControl.Label>
                    <Checkbox
                        id={addRuleId}
                        checked={addRule}
                        onChange={(event) => setAddRule(event.target.checked)}
                    />
                </FormControl>

                {addRule && (
                    <FormControl id={routeToId}>
                        <FormControl.Label>Route to</FormControl.Label>
                        <NativeSelect
                            id={routeToId}
                            block
                            value={routeTo}
                            onChange={(event) => setRouteTo(event.target.value)}
                        >
                            {!routeTo && (
                                <NativeSelect.Option value="">
                                    Choose a route out
                                </NativeSelect.Option>
                            )}
                            {outboundTags.map((tag) => (
                                <NativeSelect.Option key={tag} value={tag}>
                                    {tag}
                                </NativeSelect.Option>
                            ))}
                        </NativeSelect>
                    </FormControl>
                )}
            </Stack>
        </Dialog>
    );
};
