import { Button, InlineMessage, List, NativeSelect, Stack } from "@gamecrafters/base-ui/react";
import { useId, useRef, useState } from "react";

import { AddButton } from "@/components/AddButton";
import { FilledCheckbox, FilledSelect, FilledTextInput } from "@/components/FilledField";
import { SectionTitle } from "@/components/SectionTitle";
import { TaggedCards } from "@/components/TaggedCard";
import { toDocument, useBaseConfig, useSaveBaseConfig } from "@/features/config/api";
import { routeOf } from "@/features/rules/api";
import { keyOf } from "@/lib/rules";

import {
    DNS_STRATEGIES,
    dnsOf,
    isDnsChanged,
    moveRule,
    withDns,
    type Dns as DnsSection,
    type DnsRule,
    type DnsServer,
} from "./api";
import { DnsRuleCard } from "./components/DnsRuleCard";
import { DnsRuleDialog } from "./components/DnsRuleDialog";
import { DnsServerCard } from "./components/DnsServerCard";
import { DnsServerDialog } from "./components/DnsServerDialog";

// Three a row on a phone would not fit, so a field takes the whole row there,
// half of it on a tablet, a quarter on a laptop and a sixth on a wide screen,
// less its share of the gaps between them.
const FIELD_WIDTH =
    "w-full min-[600px]:w-[calc((100%-8px)/2)] min-[840px]:w-[calc((100%-24px)/4)] min-[1145px]:w-[calc((100%-40px)/6)]";

// Which dialog is open, and for which entry: none of it is open while this is
// null, and a new entry is being added while the index is.
interface Editing {
    index: number | null;
}

// How a node resolves names, laid out the way the reference lays it out: the
// buttons that add a server or a rule beside the one that saves, the settings
// that apply to every query, and then the servers and the rules as cards.
//
// It is all one section of the base document, so it is edited as a copy on the
// page and written back whole by Save, as the reference does it. Nothing an
// operator does here reaches a node until then, and leaving the page leaves it
// as it was.
export const Dns = () => {
    const basicsId = useId();
    const serversId = useId();
    const rulesId = useId();
    const finalId = useId();
    const strategyId = useId();
    const subnetId = useId();
    const capacityId = useId();
    const disableCacheId = useId();
    const disableExpireId = useId();
    const reverseMappingId = useId();

    const addServerRef = useRef<HTMLButtonElement>(null);
    const addRuleRef = useRef<HTMLButtonElement>(null);

    const { data: config, error: readError, isLoading } = useBaseConfig();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveBaseConfig();

    // The copy being edited, which is the document's own section until anything
    // is changed. Kept apart from what was read rather than seeded from it, so a
    // read that answers later is shown rather than overwritten by an empty copy.
    const [draft, setDraft] = useState<DnsSection | null>(null);
    const [editingServer, setEditingServer] = useState<Editing | null>(null);
    const [editingRule, setEditingRule] = useState<Editing | null>(null);
    const [dragged, setDragged] = useState<number | null>(null);

    const dns = draft ?? dnsOf(config);
    const servers = dns.servers ?? [];
    const rules = dns.rules ?? [];
    const serverTags = servers.map((server) => server.tag);
    // The rule sets a rule can match on, which the routing section keeps.
    const ruleSetTags = (routeOf(config).rule_set ?? []).map((ruleSet) => ruleSet.tag);

    // Nothing can be changed before the document has been read: a save made
    // from an empty copy would write the rest of the document back as nothing.
    const isReady = config !== undefined;
    const isChanged = draft !== null && isDnsChanged(config, draft);

    const change = (changes: Partial<DnsSection>) => setDraft({ ...dns, ...changes });

    const onSave = async () => {
        if (!config) {
            return;
        }

        // What was saved is what the API answers with, and it is in the cache
        // by the time this returns, so the page goes back to showing that.
        if (await save({ document: toDocument(withDns(config, dns)) })) {
            setDraft(null);
        }
    };

    const saveServer = (server: DnsServer) => {
        const index = editingServer?.index ?? null;

        change({
            servers:
                index === null
                    ? [...servers, server]
                    : servers.map((current, position) => (position === index ? server : current)),
        });
        setEditingServer(null);
    };

    const saveRule = (rule: DnsRule) => {
        const index = editingRule?.index ?? null;

        change({
            rules:
                index === null
                    ? [...rules, rule]
                    : rules.map((current, place) => (place === index ? rule : current)),
        });

        setEditingRule(null);
    };

    // The card deleted is gone along with its buttons, so focus goes to what
    // adds another rather than being dropped on the page.
    const deleteServer = (index: number) => {
        change({ servers: servers.filter((_, position) => position !== index) });
        addServerRef.current?.focus();
    };

    const deleteRule = (index: number) => {
        change({ rules: rules.filter((_, position) => position !== index) });
        addRuleRef.current?.focus();
    };

    // A rule dropped on another takes its place, and everything from there on
    // moves along one, the way the reference reorders them.
    const dropRule = (index: number) => {
        if (dragged !== null && dragged !== index) {
            change({ rules: moveRule(rules, dragged, index) });
        }

        setDragged(null);
    };

    return (
        <>
            <Stack gap="condensed">
                {/* Spaced the way the reference spaces them: each add button
                    carries a little room either side and Save none, so the three
                    sit just right of the middle. */}
                <div className="flex justify-center [&>*]:mx-[5px] [&>*:last-child]:mx-0">
                    <AddButton
                        ref={addServerRef}
                        label="Add DNS server"
                        spellsOut
                        disabled={!isReady}
                        onClick={() => setEditingServer({ index: null })}
                    />
                    <AddButton
                        ref={addRuleRef}
                        label="Add DNS rule"
                        spellsOut
                        disabled={!isReady}
                        onClick={() => setEditingRule({ index: null })}
                    />
                    {/* Outlined in the colour of something not yet done, and
                        faded out until there is something to save. */}
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

                <SectionTitle id={basicsId}>Basics</SectionTitle>

                {/* One row that wraps rather than a grid: the lists take a set
                    share of it and the rest are as wide as what they hold, which
                    is how the reference's settle into lines. */}
                <div role="group" aria-labelledby={basicsId} className="flex flex-wrap gap-2">
                    <FilledSelect
                        id={finalId}
                        label="Final"
                        className={FIELD_WIDTH}
                        disabled={!isReady}
                        value={dns.final ?? ""}
                        onChange={(event) => change({ final: event.target.value || undefined })}
                    >
                        {/* Where a query no rule matches goes. Left unset, the
                            core asks the first server in the list. */}
                        <NativeSelect.Option value="">First server</NativeSelect.Option>
                        {serverTags.map((tag) => (
                            <NativeSelect.Option key={tag} value={tag}>
                                {tag}
                            </NativeSelect.Option>
                        ))}
                        {/* A server deleted out from under it would otherwise
                            land on the first one without anyone choosing that. */}
                        {dns.final && !serverTags.includes(dns.final) && (
                            <NativeSelect.Option value={dns.final}>
                                {dns.final} — no longer exists
                            </NativeSelect.Option>
                        )}
                    </FilledSelect>

                    <FilledSelect
                        id={strategyId}
                        label="Domain strategy"
                        className={FIELD_WIDTH}
                        disabled={!isReady}
                        value={dns.strategy ?? ""}
                        onChange={(event) => change({ strategy: event.target.value || undefined })}
                    >
                        <NativeSelect.Option value="">Default</NativeSelect.Option>
                        {DNS_STRATEGIES.map((strategy) => (
                            <NativeSelect.Option key={strategy} value={strategy}>
                                {strategy}
                            </NativeSelect.Option>
                        ))}
                        {dns.strategy && !DNS_STRATEGIES.includes(dns.strategy) && (
                            <NativeSelect.Option value={dns.strategy}>
                                {dns.strategy} — not one this panel knows
                            </NativeSelect.Option>
                        )}
                    </FilledSelect>

                    <FilledTextInput
                        id={subnetId}
                        label="Client subnet"
                        className={FIELD_WIDTH}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!isReady}
                        value={dns.client_subnet ?? ""}
                        onChange={(event) =>
                            change({ client_subnet: event.target.value.trim() || undefined })
                        }
                    />

                    {/* As wide as the reference's whatever the screen, since it
                        holds a number rather than a name. */}
                    <FilledTextInput
                        id={capacityId}
                        label="Cache capacity"
                        className="w-[229px]"
                        type="number"
                        inputMode="numeric"
                        min={1024}
                        disabled={!isReady}
                        value={dns.cache_capacity === undefined ? "" : String(dns.cache_capacity)}
                        onChange={(event) =>
                            change({
                                cache_capacity:
                                    event.target.value === ""
                                        ? undefined
                                        : Number(event.target.value),
                            })
                        }
                    />

                    {/* Cleared rather than written as false when switched off, so a
                        box ticked and unticked again leaves the document as it
                        found it. */}
                    <FilledCheckbox
                        id={disableCacheId}
                        label="Disable cache"
                        disabled={!isReady}
                        checked={dns.disable_cache === true}
                        onChange={(event) =>
                            change({ disable_cache: event.target.checked || undefined })
                        }
                    />
                    <FilledCheckbox
                        id={disableExpireId}
                        label="Disable expire"
                        disabled={!isReady}
                        checked={dns.disable_expire === true}
                        onChange={(event) =>
                            change({ disable_expire: event.target.checked || undefined })
                        }
                    />
                    <FilledCheckbox
                        id={reverseMappingId}
                        label="Reverse mapping"
                        disabled={!isReady}
                        checked={dns.reverse_mapping === true}
                        onChange={(event) =>
                            change({ reverse_mapping: event.target.checked || undefined })
                        }
                    />
                </div>

                <SectionTitle id={serversId}>DNS servers</SectionTitle>

                <TaggedCards labelledBy={serversId} isLoading={isLoading}>
                    {servers.map((server, index) => (
                        <List.Item key={keyOf(server)}>
                            <DnsServerCard
                                server={server}
                                onEdit={() => setEditingServer({ index })}
                                onDelete={() => deleteServer(index)}
                            />
                        </List.Item>
                    ))}
                </TaggedCards>

                <SectionTitle id={rulesId}>DNS rules</SectionTitle>

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
                            <DnsRuleCard
                                rule={rule}
                                position={index}
                                serverTags={serverTags}
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
            {editingServer && (
                <DnsServerDialog
                    server={editingServer.index === null ? undefined : servers[editingServer.index]}
                    takenTags={serverTags}
                    onSave={saveServer}
                    onClose={() => setEditingServer(null)}
                    returnFocusRef={addServerRef}
                />
            )}

            {editingRule && (
                <DnsRuleDialog
                    rule={editingRule.index === null ? undefined : rules[editingRule.index]}
                    serverTags={serverTags}
                    ruleSetTags={ruleSetTags}
                    onSave={saveRule}
                    onClose={() => setEditingRule(null)}
                    returnFocusRef={addRuleRef}
                />
            )}
        </>
    );
};
