import {
    Dialog,
    FormControl,
    NativeSelect,
    NumberInput,
    Stack,
    Text,
    Textarea,
} from "@gamecrafters/base-ui/react";
import { useId, useState, type RefObject } from "react";

import type { Outbound } from "@/features/outbounds/api";

import {
    isPlainDirect,
    readUrls,
    remoteRuleSet,
    RULE_SET_FORMATS,
    tagFromUrl,
    type RuleSet,
} from "../api";

interface ImportRuleSetsDialogProps {
    // The tags the rule sets already have, which one imported under is left out.
    takenTags: string[];
    // The routes out a download can go through, by tag, and the records behind
    // them.
    outboundTags: string[];
    outbounds: Outbound[];
    onImport: (ruleSets: RuleSet[]) => void;
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

// Remote rule sets added in a batch from a list of the addresses they are
// downloaded from, each tagged with the name of the file it points at, as the
// reference does it. They go into the page, and are written by its Save.
export const ImportRuleSetsDialog = ({
    takenTags,
    outboundTags,
    outbounds,
    onImport,
    onClose,
    returnFocusRef,
}: ImportRuleSetsDialogProps) => {
    const urlsId = useId();
    const formatId = useId();
    const detourId = useId();
    const daysId = useId();

    const [urls, setUrls] = useState("");
    const [format, setFormat] = useState("binary");
    const [detour, setDetour] = useState("");
    const [days, setDays] = useState(1);

    // A tag already taken is left out, whether by a rule set the page holds or
    // by an address earlier in the list that names a file of the same name.
    const taken = new Set(takenTags);
    const fresh: { url: string; tag: string }[] = [];
    const skipped: string[] = [];

    for (const url of readUrls(urls)) {
        const tag = tagFromUrl(url);

        if (taken.has(tag)) {
            skipped.push(tag);
        } else {
            fresh.push({ url, tag });
            taken.add(tag);
        }
    }

    // A plain direct route out is what no detour already means, and the core
    // refuses a detour that changes nothing, so it is written as none.
    const via = isPlainDirect(outbounds.find((outbound) => outbound.tag === detour))
        ? undefined
        : detour || undefined;

    return (
        <Dialog
            title="Import rule sets"
            subtitle="Kept on the page until it is saved."
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width="large"
            footerButtons={[
                { content: "Cancel", onClick: onClose },
                {
                    content: "Add rule sets",
                    buttonType: "primary",
                    disabled: fresh.length === 0,
                    onClick: () =>
                        onImport(
                            fresh.map(({ url, tag }) =>
                                remoteRuleSet({ tag, url, format, detour: via, days }),
                            ),
                        ),
                },
            ]}
        >
            <Stack gap="normal">
                <FormControl id={urlsId}>
                    <FormControl.Label>Addresses</FormControl.Label>
                    <Textarea
                        id={urlsId}
                        block
                        rows={8}
                        spellCheck={false}
                        className="font-mono"
                        placeholder="https://example.com/geosite-youtube.srs"
                        value={urls}
                        onChange={(event) => setUrls(event.target.value)}
                    />
                    <FormControl.Caption>
                        One to a line. Each is tagged with the name of the file it points at.
                    </FormControl.Caption>
                </FormControl>

                <Stack direction="horizontal" gap="normal" wrap="wrap">
                    <Stack.Item grow className="min-w-40 basis-0">
                        <FormControl id={formatId}>
                            <FormControl.Label>Format</FormControl.Label>
                            <NativeSelect
                                id={formatId}
                                block
                                value={format}
                                onChange={(event) => setFormat(event.target.value)}
                            >
                                {RULE_SET_FORMATS.map((value) => (
                                    <NativeSelect.Option key={value} value={value}>
                                        {value}
                                    </NativeSelect.Option>
                                ))}
                            </NativeSelect>
                        </FormControl>
                    </Stack.Item>

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

                {(fresh.length > 0 || skipped.length > 0) && (
                    <Text as="p" className="m-0">
                        {fresh.length > 0 && `Adds ${fresh.map(({ tag }) => tag).join(", ")}. `}
                        {skipped.length > 0 &&
                            `${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} left out, the tag being taken already.`}
                    </Text>
                )}
            </Stack>
        </Dialog>
    );
};
