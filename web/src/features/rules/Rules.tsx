import {
    ActionList,
    ActionMenu,
    Button,
    IconButton,
    InlineMessage,
    List,
    NativeSelect,
    Stack,
} from "@gamecrafters/base-ui/react";
import {
    ArrowDownloadRegular,
    ArrowImportRegular,
    StarRegular,
    WrenchScrewdriverRegular,
} from "@gamecrafters/base-ui-icons";
import { useId, useRef, useState } from "react";

import { AddButton } from "@/components/AddButton";
import { FilledSelect, FilledSwitch, FilledTextInput } from "@/components/FilledField";
import { SectionTitle } from "@/components/SectionTitle";
import { TaggedCards } from "@/components/TaggedCard";
import { toDocument, useBaseConfig, useSaveBaseConfig } from "@/features/config/api";
import { dnsOf } from "@/features/dns/api";
import { useOutbounds } from "@/features/outbounds/api";
import { keyOf } from "@/lib/rules";

import {
    isRouteChanged,
    moveRule,
    resolverOf,
    routeOf,
    withRoute,
    type Route,
    type RouteRule,
    type RuleSet,
} from "./api";
import { ImportRulesDialog } from "./components/ImportRulesDialog";
import { ImportRuleSetsDialog } from "./components/ImportRuleSetsDialog";
import { PresetRuleSetsDialog } from "./components/PresetRuleSetsDialog";
import { RuleCard } from "./components/RuleCard";
import { RuleDialog } from "./components/RuleDialog";
import { RuleSetCard } from "./components/RuleSetCard";
import { RuleSetDialog } from "./components/RuleSetDialog";

// A whole row on a phone, half of it on a tablet, a quarter on a laptop and a
// sixth on a wide screen, less its share of the gaps between them.
const FIELD_WIDTH =
    "w-full min-[600px]:w-[calc((100%-8px)/2)] min-[840px]:w-[calc((100%-24px)/4)] min-[1145px]:w-[calc((100%-40px)/6)]";

// Which rule's dialog is open: none while this is null, and a new rule while
// its index is null.
interface Editing {
    index: number | null;
}

type Tool = "rules" | "ruleSets" | "presets";

// Where a node sends a connection, laid out the way the reference lays it out:
// the button that adds a rule, the tools that bring them in from
// elsewhere and the one that saves, then the settings that apply to every
// connection, the rule sets, and the rules in the order they are checked.
//
// Like DNS, it is one section of the base document, edited as a copy on the page
// and written back whole by Save.
export const Rules = () => {
    const routingId = useId();
    const ruleSetsId = useId();
    const rulesId = useId();
    const finalId = useId();
    const resolverId = useId();
    const interfaceId = useId();
    const markId = useId();
    const httpClientId = useId();

    const addRuleRef = useRef<HTMLButtonElement>(null);
    const toolsRef = useRef<HTMLButtonElement>(null);

    const { data: config, error: readError, isLoading } = useBaseConfig();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveBaseConfig();
    const { data: outbounds } = useOutbounds();

    // The copy being edited, which is the document's own section until anything
    // is changed.
    const [draft, setDraft] = useState<Route | null>(null);
    const [editingRule, setEditingRule] = useState<Editing | null>(null);
    const [editingRuleSet, setEditingRuleSet] = useState<number | null>(null);
    const [tool, setTool] = useState<Tool | null>(null);
    const [dragged, setDragged] = useState<number | null>(null);

    const route = draft ?? routeOf(config);
    const rules = route.rules ?? [];
    const ruleSets = route.rule_set ?? [];
    const ruleSetTags = ruleSets.map((ruleSet) => ruleSet.tag);

    // A rule sends a connection to a route out by its tag, a WireGuard tunnel's
    // as any other's.
    const outboundTags = (outbounds ?? []).map((outbound) => outbound.tag);
    const dnsTags = (dnsOf(config).servers ?? []).map((server) => server.tag);
    const httpClientTags = Array.isArray(config?.http_clients)
        ? config.http_clients
              .map((client: unknown) => (client as { tag?: unknown })?.tag)
              .filter((tag): tag is string => typeof tag === "string" && tag !== "")
        : [];

    // Nothing can be changed before the document has been read: a save made from
    // an empty copy would write the rest of the document back as nothing.
    const isReady = config !== undefined;
    const isChanged = draft !== null && isRouteChanged(config, draft);

    const change = (changes: Partial<Route>) => setDraft({ ...route, ...changes });

    const onSave = async () => {
        if (!config) {
            return;
        }

        if (await save({ document: toDocument(withRoute(config, route)) })) {
            setDraft(null);
        }
    };

    const saveRule = (rule: RouteRule) => {
        const index = editingRule?.index ?? null;

        change({
            rules:
                index === null
                    ? [...rules, rule]
                    : rules.map((current, place) => (place === index ? rule : current)),
        });

        setEditingRule(null);
    };

    const saveRuleSet = (ruleSet: RuleSet) => {
        if (editingRuleSet === null) {
            return;
        }

        change({
            rule_set: ruleSets.map((current, position) =>
                position === editingRuleSet ? ruleSet : current,
            ),
        });
        setEditingRuleSet(null);
    };

    // The card deleted is gone along with its buttons, so focus goes to the
    // toolbar.
    const deleteRule = (index: number) => {
        change({ rules: rules.filter((_, position) => position !== index) });
        addRuleRef.current?.focus();
    };

    const deleteRuleSet = (index: number) => {
        change({ rule_set: ruleSets.filter((_, position) => position !== index) });
        toolsRef.current?.focus();
    };

    // A rule dropped on another takes its place, and everything from there on
    // moves along one, the way the reference reorders them.
    const dropRule = (index: number) => {
        if (dragged !== null && dragged !== index) {
            change({ rules: moveRule(rules, dragged, index) });
        }

        setDragged(null);
    };

    const addRuleSets = (added: RuleSet[], rule: RouteRule | null = null) => {
        change({
            rule_set: [...ruleSets, ...added],
            ...(rule ? { rules: [...rules, rule] } : {}),
        });
        setTool(null);
    };

    const markValue = typeof route.default_mark === "number" ? route.default_mark : 0;

    return (
        <>
            <Stack gap="condensed">
                {/* Spaced the way the reference spaces them: the add button with a
                    little room either side, the tools and Save with none. */}
                <div className="flex items-center justify-center">
                    <span className="mx-[5px] inline-flex">
                        <AddButton
                            ref={addRuleRef}
                            label="Add rule"
                            spellsOut
                            disabled={!isReady}
                            onClick={() => setEditingRule({ index: null })}
                        />
                    </span>
                    {/* What brings rules and rule sets in from elsewhere rather
                        than one at a time. */}
                    <ActionMenu>
                        <ActionMenu.Anchor>
                            <IconButton
                                ref={toolsRef}
                                icon={<WrenchScrewdriverRegular size={24} />}
                                aria-label="Tools"
                                variant="invisible"
                                disabled={!isReady}
                                className="size-12 rounded-full text-[var(--foreground-color-accent)]"
                            />
                        </ActionMenu.Anchor>

                        <ActionMenu.Overlay align="center">
                            <ActionList>
                                <ActionList.Item onSelect={() => setTool("rules")}>
                                    <ActionList.LeadingVisual>
                                        <ArrowImportRegular />
                                    </ActionList.LeadingVisual>
                                    Import rules
                                </ActionList.Item>
                                <ActionList.Item onSelect={() => setTool("ruleSets")}>
                                    <ActionList.LeadingVisual>
                                        <ArrowDownloadRegular />
                                    </ActionList.LeadingVisual>
                                    Import rule sets
                                </ActionList.Item>
                                <ActionList.Item onSelect={() => setTool("presets")}>
                                    <ActionList.LeadingVisual>
                                        <StarRegular />
                                    </ActionList.LeadingVisual>
                                    Preset rule sets
                                </ActionList.Item>
                            </ActionList>
                        </ActionMenu.Overlay>
                    </ActionMenu>

                    {/* Outlined in the colour of something not yet done, and faded
                        out until there is something to save. */}
                    <Button
                        loading={isSaving}
                        disabled={!isReady || !isChanged}
                        className="h-9 min-w-16 rounded-[4px] border-[var(--border-color-attention-emphasis)] bg-transparent px-4 text-[14px] text-[var(--foreground-color-attention)] disabled:opacity-[0.26]"
                        onClick={() => void onSave()}
                    >
                        Save
                    </Button>
                </div>

                {readError && <InlineMessage variant="critical">{readError.message}</InlineMessage>}
                {saveError && <InlineMessage variant="critical">{saveError.message}</InlineMessage>}

                <SectionTitle id={routingId}>Routing</SectionTitle>

                <div role="group" aria-labelledby={routingId} className="flex flex-wrap gap-2">
                    <FilledSelect
                        id={finalId}
                        label="Default outbound"
                        className={FIELD_WIDTH}
                        disabled={!isReady}
                        value={route.final ?? ""}
                        onChange={(event) => change({ final: event.target.value || undefined })}
                    >
                        {/* Where a connection no rule matches goes. Left unset, the
                            core sends it through the first route out. */}
                        <NativeSelect.Option value="">First outbound</NativeSelect.Option>
                        {outboundTags.map((tag) => (
                            <NativeSelect.Option key={tag} value={tag}>
                                {tag}
                            </NativeSelect.Option>
                        ))}
                        {route.final && !outboundTags.includes(route.final) && (
                            <NativeSelect.Option value={route.final}>
                                {route.final} — no longer exists
                            </NativeSelect.Option>
                        )}
                    </FilledSelect>

                    {/* Which DNS server resolves the names the routes out dial. The
                        core guesses when there are several and none is named. */}
                    <FilledSelect
                        id={resolverId}
                        label="Default DNS resolver"
                        className={FIELD_WIDTH}
                        disabled={!isReady}
                        value={resolverOf(route)}
                        onChange={(event) =>
                            change({ default_domain_resolver: event.target.value || undefined })
                        }
                    >
                        <NativeSelect.Option value="">Default</NativeSelect.Option>
                        {dnsTags.map((tag) => (
                            <NativeSelect.Option key={tag} value={tag}>
                                {tag}
                            </NativeSelect.Option>
                        ))}
                        {resolverOf(route) && !dnsTags.includes(resolverOf(route)) && (
                            <NativeSelect.Option value={resolverOf(route)}>
                                {resolverOf(route)} — no longer exists
                            </NativeSelect.Option>
                        )}
                    </FilledSelect>

                    <FilledTextInput
                        id={interfaceId}
                        label="Default interface"
                        className={FIELD_WIDTH}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!isReady}
                        value={route.default_interface ?? ""}
                        onChange={(event) =>
                            change({ default_interface: event.target.value.trim() || undefined })
                        }
                    />

                    {/* Shown as nought when there is none, as the reference shows
                        it, and cleared from the document rather than written as
                        nought. */}
                    <FilledTextInput
                        id={markId}
                        label="Default routing mark"
                        className={FIELD_WIDTH}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        disabled={!isReady}
                        value={String(markValue)}
                        onChange={(event) => {
                            const mark = Number(event.target.value);

                            change({ default_mark: mark > 0 ? mark : undefined });
                        }}
                    />

                    {/* Which shared client downloads the rule sets that name none. */}
                    <FilledSelect
                        id={httpClientId}
                        label="HTTP client"
                        className={FIELD_WIDTH}
                        disabled={!isReady}
                        value={route.default_http_client ?? ""}
                        onChange={(event) =>
                            change({ default_http_client: event.target.value || undefined })
                        }
                    >
                        <NativeSelect.Option value="">
                            {httpClientTags.length ? "Default" : "None defined"}
                        </NativeSelect.Option>
                        {httpClientTags.map((tag) => (
                            <NativeSelect.Option key={tag} value={tag}>
                                {tag}
                            </NativeSelect.Option>
                        ))}
                        {route.default_http_client &&
                            !httpClientTags.includes(route.default_http_client) && (
                                <NativeSelect.Option value={route.default_http_client}>
                                    {route.default_http_client} — no longer exists
                                </NativeSelect.Option>
                            )}
                    </FilledSelect>

                    {/* auto_detect_interface: the core binds what goes out to the
                        default interface, which is what keeps a tun listener from
                        routing its own traffic back into itself. */}
                    <FilledSwitch
                        label="Auto-bind interface"
                        className={FIELD_WIDTH}
                        disabled={!isReady}
                        checked={route.auto_detect_interface === true}
                        onCheckedChange={(checked) =>
                            change({ auto_detect_interface: checked || undefined })
                        }
                    />
                </div>

                <SectionTitle id={ruleSetsId}>Rule sets</SectionTitle>

                <TaggedCards labelledBy={ruleSetsId} isLoading={isLoading}>
                    {ruleSets.map((ruleSet, index) => (
                        <List.Item key={keyOf(ruleSet)}>
                            <RuleSetCard
                                ruleSet={ruleSet}
                                onEdit={() => setEditingRuleSet(index)}
                                onDelete={() => deleteRuleSet(index)}
                            />
                        </List.Item>
                    ))}
                </TaggedCards>

                <SectionTitle id={rulesId}>Rules</SectionTitle>

                <TaggedCards labelledBy={rulesId} isLoading={isLoading}>
                    {rules.map((rule, index) => (
                        <List.Item
                            key={keyOf(rule)}
                            draggable
                            onDragStart={(event) => {
                                // Some browsers start no drag without something
                                // being carried, so the place it came from is.
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", String(index));
                                setDragged(index);
                            }}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                                event.preventDefault();
                                dropRule(index);
                            }}
                            onDragEnd={() => setDragged(null)}
                        >
                            <RuleCard
                                rule={rule}
                                position={index}
                                outboundTags={outboundTags}
                                onEdit={() => setEditingRule({ index })}
                                onDelete={() => deleteRule(index)}
                            />
                        </List.Item>
                    ))}
                </TaggedCards>
            </Stack>

            {/* Mounted only while open, so what was typed into one is gone by the
                time it is opened again. Focus goes back to the Add button when
                the dialog closes. */}
            {editingRule && (
                <RuleDialog
                    rule={editingRule.index === null ? undefined : rules[editingRule.index]}
                    outboundTags={outboundTags}
                    ruleSetTags={ruleSetTags}
                    onSave={saveRule}
                    onClose={() => setEditingRule(null)}
                    returnFocusRef={addRuleRef}
                />
            )}

            {editingRuleSet !== null && (
                <RuleSetDialog
                    ruleSet={ruleSets[editingRuleSet]}
                    httpClientTags={httpClientTags}
                    outboundTags={outboundTags}
                    onSave={saveRuleSet}
                    onClose={() => setEditingRuleSet(null)}
                    returnFocusRef={toolsRef}
                />
            )}

            {tool === "rules" && (
                <ImportRulesDialog
                    route={route}
                    onImport={(imported) => {
                        change(imported);
                        setTool(null);
                    }}
                    onClose={() => setTool(null)}
                    returnFocusRef={toolsRef}
                />
            )}

            {tool === "ruleSets" && (
                <ImportRuleSetsDialog
                    takenTags={ruleSetTags}
                    outboundTags={outboundTags}
                    outbounds={outbounds ?? []}
                    onImport={addRuleSets}
                    onClose={() => setTool(null)}
                    returnFocusRef={toolsRef}
                />
            )}

            {tool === "presets" && (
                <PresetRuleSetsDialog
                    takenTags={ruleSetTags}
                    outboundTags={outboundTags}
                    outbounds={outbounds ?? []}
                    onImport={addRuleSets}
                    onClose={() => setTool(null)}
                    returnFocusRef={toolsRef}
                />
            )}
        </>
    );
};
