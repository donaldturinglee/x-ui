import { Button, InlineMessage, NativeSelect, Text } from "@gamecrafters/base-ui/react";
import { useId, useState, type FormEvent } from "react";

import { DocLink } from "@/components/DocLink";
import { FilledSelect, FilledSwitch, FilledTextInput } from "@/components/FilledField";
import { toDocument, useBaseConfig, useSaveBaseConfig } from "@/features/config/api";

import { isLogChanged, LOG_DOCS, LOG_LEVELS, logOf, withLog, type Log } from "../api/log";

import { FIELDS, FOOTER, SAVE_BUTTON } from "./layout";

// What every node's core logs: whether it logs at all, how much, where to, and
// whether each line is stamped with the time -- the fields of the reference's
// log panel, which it keeps on its basics page.
//
// They are the base document's `log` key, so the tab edits a copy of it and
// writes the document back whole when Save is pressed, as the experimental
// interfaces' tab does with its own. It is the nodes' log rather than the
// panel's: what the panel has been saying is read from the overview, and how
// much it says is set in configs/config.yaml, which the Panel tab shows.
export const LogsTab = () => {
    const levelId = useId();
    const outputId = useId();

    const { data: config, error: readError } = useBaseConfig();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveBaseConfig();

    // The copy being edited, which is the document's own until anything changes.
    const [draft, setDraft] = useState<Log | null>(null);

    const log = draft ?? logOf(config);

    // Nothing can be changed before the document has been read: a save made from
    // an empty copy would write the rest of the document back as nothing.
    const isReady = config !== undefined;
    const isChanged = draft !== null && isLogChanged(config, draft);

    const change = (changes: Log) => setDraft({ ...log, ...changes });

    const onSave = async (event: FormEvent) => {
        event.preventDefault();

        if (!config) {
            return;
        }

        if (await save({ document: toDocument(withLog(config, log)) })) {
            setDraft(null);
        }
    };

    return (
        <form aria-label="Logs" onSubmit={(event) => void onSave(event)} noValidate>
            <div className="p-4">
                <Text
                    as="p"
                    className="mb-4 text-[14px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    What every node's core logs, written into the base document the nodes are
                    configured from. The panel's own log is on the overview.{" "}
                    <DocLink href={LOG_DOCS} label="Logs" />
                </Text>

                {readError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}

                <div className={FIELDS}>
                    <FilledSwitch
                        label="Disabled"
                        disabled={!isReady}
                        checked={log.disabled === true}
                        onCheckedChange={(disabled) => change({ disabled: disabled || undefined })}
                    />
                    <FilledSelect
                        id={levelId}
                        label="Level"
                        disabled={!isReady}
                        value={typeof log.level === "string" ? log.level : ""}
                        onChange={(event) => change({ level: event.target.value || undefined })}
                    >
                        <NativeSelect.Option value="">Default</NativeSelect.Option>
                        {LOG_LEVELS.map((level) => (
                            <NativeSelect.Option key={level} value={level}>
                                {level}
                            </NativeSelect.Option>
                        ))}
                    </FilledSelect>
                    <FilledTextInput
                        id={outputId}
                        label="Output"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!isReady}
                        value={typeof log.output === "string" ? log.output : ""}
                        onChange={(event) => change({ output: event.target.value || undefined })}
                    />
                    <FilledSwitch
                        label="Timestamp"
                        disabled={!isReady}
                        checked={log.timestamp === true}
                        onCheckedChange={(timestamp) =>
                            change({ timestamp: timestamp || undefined })
                        }
                    />
                </div>

                {saveError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {saveError.message}
                    </InlineMessage>
                )}
            </div>

            {/* Save last, where a dialog keeps it, faded out until there is
                something to save. */}
            <div className={FOOTER}>
                <Button
                    type="submit"
                    variant="primary"
                    loading={isSaving}
                    disabled={!isReady || !isChanged}
                    className={SAVE_BUTTON}
                >
                    Save
                </Button>
            </div>
        </form>
    );
};
