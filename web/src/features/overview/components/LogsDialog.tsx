import {
    Dialog,
    FormControl,
    IconButton,
    InlineMessage,
    NativeSelect,
    SkeletonText,
    Stack,
    Text,
} from "@gamecrafters/base-ui/react";
import { ArrowSyncRegular } from "@gamecrafters/base-ui-icons";
import { useId, useState, type RefObject } from "react";

import { useLogs, type LogLevel } from "@/features/diagnostics/api";

interface LogsDialogProps {
    onClose: () => void;
    returnFocusRef: RefObject<HTMLButtonElement | null>;
}

const LEVELS: LogLevel[] = ["debug", "info", "warning", "error"];

// Few enough that the box is read rather than scrolled through, and enough that
// something a few minutes old is still in it.
const COUNTS = [10, 20, 50, 100, 200];

// What the process has been saying. Read from an in-memory ring, so it is this
// process only and starts empty after a restart -- said on screen, because an
// empty log is otherwise read as a quiet panel rather than a fresh one.
export const LogsDialog = ({ onClose, returnFocusRef }: LogsDialogProps) => {
    const levelId = useId();
    const countId = useId();

    const [level, setLevel] = useState<LogLevel>("info");
    const [count, setCount] = useState(100);

    const { data: lines, error, isLoading, isValidating, mutate } = useLogs(level, count);

    return (
        <Dialog
            title="Logs"
            // Said where the log is opened rather than beside the level, because
            // it is true of the whole of it: an empty log after a restart is not
            // a quiet panel.
            subtitle="This process only, and only since it started."
            onClose={onClose}
            returnFocusRef={returnFocusRef}
            width={1200}
        >
            <Stack gap="normal">
                <Stack direction="horizontal" gap="normal" align="end" wrap="wrap">
                    <Stack.Item grow className="min-w-40">
                        <FormControl id={levelId}>
                            <FormControl.Label>Level</FormControl.Label>
                            <NativeSelect
                                id={levelId}
                                block
                                value={level}
                                onChange={(event) => setLevel(event.target.value as LogLevel)}
                            >
                                {LEVELS.map((value) => (
                                    <NativeSelect.Option key={value} value={value}>
                                        {value}
                                    </NativeSelect.Option>
                                ))}
                            </NativeSelect>
                        </FormControl>
                    </Stack.Item>

                    <Stack.Item grow className="min-w-40">
                        <FormControl id={countId}>
                            <FormControl.Label>Lines</FormControl.Label>
                            <NativeSelect
                                id={countId}
                                block
                                value={String(count)}
                                onChange={(event) => setCount(Number(event.target.value))}
                            >
                                {COUNTS.map((value) => (
                                    <NativeSelect.Option key={value} value={String(value)}>
                                        {value}
                                    </NativeSelect.Option>
                                ))}
                            </NativeSelect>
                        </FormControl>
                    </Stack.Item>

                    {/* The log is not polled: it is read when something has
                        already gone wrong, and an operator watching for the next
                        line should be able to ask for it rather than wait. */}
                    <IconButton
                        icon={<ArrowSyncRegular size={24} />}
                        aria-label="Read the log again"
                        loading={isValidating}
                        className="size-12 rounded-full"
                        onClick={() => void mutate()}
                    />
                </Stack>

                {error && <InlineMessage variant="critical">{error.message}</InlineMessage>}

                {isLoading && <SkeletonText lines={6} />}

                {lines &&
                    (lines.length ? (
                        // Newest last, as the process wrote them, and scrolled
                        // rather than truncated: a log that hid its own end would
                        // be hiding the part anyone opened it for.
                        //
                        // Text rather than markup, because these lines quote what
                        // whoever connected sent -- a hostname, an SNI, a URL.
                        <Stack
                            gap="none"
                            className="max-h-96 overflow-auto rounded bg-[var(--background-color-inset)] p-2"
                        >
                            {lines.map((line, index) => (
                                <Text
                                    key={`${index}-${line}`}
                                    className="font-mono text-xs whitespace-pre-wrap"
                                >
                                    {line}
                                </Text>
                            ))}
                        </Stack>
                    ) : (
                        <Text className="opacity-70">
                            Nothing at this level since the process started.
                        </Text>
                    ))}
            </Stack>
        </Dialog>
    );
};
