import { Button, Heading, InlineMessage } from "@gamecrafters/base-ui/react";
import { useId, useState, type FormEvent } from "react";

import { FilledListField, FilledSwitch, FilledTextInput } from "@/components/FilledField";

import {
    fromTelegramSettings,
    TELEGRAM_KEYS,
    telegramRequest,
    toTelegramPayload,
    useResetSettings,
    useSaveSettings,
    useSendTelegramTest,
    useSettings,
    type TelegramRequest,
} from "../api";

import { FIELDS, FOOTER, GROUP_HEADING, PLAIN_BUTTON, RESTORE_BUTTON, SAVE_BUTTON } from "./layout";

// What the fields show before the settings have been read: the API's own
// defaults, so nothing reads as blank for the moment the read takes.
const DEFAULTS: TelegramRequest = {
    enabled: false,
    token: "",
    chats: [],
    notifySignIn: true,
    notifyDeplete: true,
};

// The Telegram bot the panel tells its operators things through: whether it
// sends anything, the token @BotFather handed out for it and the chats it sends
// to, and which events are worth a message. The bot answers nothing -- the
// panel posts to Telegram when something happens and that is all -- so there is
// no process to run for it, and a message is sent from whichever of the panel
// and the worker saw the event.
//
// A test message goes to the chats as they are saved, whether or not the bot is
// switched on, which is how a token is tried before anything depends on it.
export const TelegramTab = () => {
    const tokenId = useId();
    const chatsId = useId();

    const { data: settings, error: readError, isLoading } = useSettings();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveSettings();
    const {
        trigger: restore,
        isMutating: isResetting,
        error: resetError,
    } = useResetSettings(TELEGRAM_KEYS);
    const {
        trigger: sendTest,
        data: isTestSent,
        isMutating: isTesting,
        error: testError,
        reset: forgetTest,
    } = useSendTelegramTest();

    // What was typed, kept apart from what was read until it is saved, so a read
    // that answers later is shown rather than overwritten.
    const [draft, setDraft] = useState<TelegramRequest | null>(null);

    const saved = settings ? fromTelegramSettings(settings) : undefined;
    const values = draft ?? saved ?? DEFAULTS;
    const isChanged =
        draft !== null && saved !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
    const checked = telegramRequest.safeParse(values);
    const canTest = saved !== undefined && saved.token !== "" && saved.chats.length > 0;

    const change = (changes: Partial<TelegramRequest>) => {
        forgetTest();
        setDraft({ ...values, ...changes });
    };

    const onSave = async (event: FormEvent) => {
        event.preventDefault();

        if (checked.success && (await save(toTelegramPayload(checked.data)))) {
            setDraft(null);
        }
    };

    const onRestore = async () => {
        if (await restore()) {
            setDraft(null);
        }
    };

    return (
        <form aria-label="Telegram Bot" onSubmit={(event) => void onSave(event)} noValidate>
            <div className="p-4">
                {readError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}

                <div className={FIELDS}>
                    <FilledSwitch
                        label="Send notifications"
                        className="min-[600px]:col-span-2 min-[840px]:col-span-3"
                        disabled={isLoading}
                        checked={values.enabled}
                        onCheckedChange={(enabled) => change({ enabled })}
                    />

                    {/* A token is long, so it is given the room an address is. */}
                    <FilledTextInput
                        id={tokenId}
                        label="Bot token"
                        className="min-[600px]:col-span-2"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={isLoading}
                        value={values.token}
                        onChange={(event) => change({ token: event.target.value })}
                    />

                    {/* Keyed by the chats as they are saved, so the field starts
                        afresh from what was read rather than from the empty list
                        it had before the read answered. */}
                    <FilledListField
                        key={saved?.chats.join(",") ?? ""}
                        id={chatsId}
                        label="Chat IDs (comma separated)"
                        separator=","
                        disabled={isLoading}
                        value={values.chats}
                        onChange={(chats) => change({ chats })}
                    />
                </div>

                <Heading as="h3" className={GROUP_HEADING}>
                    What the chats are told
                </Heading>

                <div className={FIELDS}>
                    <FilledSwitch
                        label="Operator sign-ins"
                        className="min-[600px]:col-start-1"
                        disabled={isLoading}
                        checked={values.notifySignIn}
                        onCheckedChange={(notifySignIn) => change({ notifySignIn })}
                    />
                    <FilledSwitch
                        label="Subscribers taken offline for quota or expiry"
                        className="min-[600px]:col-span-2 min-[600px]:col-start-1"
                        disabled={isLoading}
                        checked={values.notifyDeplete}
                        onCheckedChange={(notifyDeplete) => change({ notifyDeplete })}
                    />
                </div>

                {!checked.success && (
                    <InlineMessage variant="critical" className="mt-4">
                        {checked.error.issues[0]?.message}
                    </InlineMessage>
                )}

                {/* What the API or Telegram refused is read here as it came:
                    a chat the bot was never started in says so. */}
                {saveError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {saveError.message}
                    </InlineMessage>
                )}
                {resetError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {resetError.message}
                    </InlineMessage>
                )}
                {testError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {testError.message}
                    </InlineMessage>
                )}
                {isTestSent && (
                    <InlineMessage variant="success" className="mt-4">
                        A test message was sent to every chat.
                    </InlineMessage>
                )}
            </div>

            {/* The test goes out with the bot as it is saved, so it waits for
                what was typed to be saved first. */}
            <div className={FOOTER}>
                <Button
                    type="button"
                    loading={isTesting}
                    disabled={!canTest || isChanged}
                    className={PLAIN_BUTTON}
                    onClick={() => void sendTest()}
                >
                    Send a test message
                </Button>

                <Button
                    type="button"
                    loading={isResetting}
                    disabled={isLoading || isChanged}
                    className={RESTORE_BUTTON}
                    onClick={() => void onRestore()}
                >
                    Restore defaults
                </Button>

                <Button
                    type="submit"
                    variant="primary"
                    loading={isSaving}
                    disabled={!isChanged || !checked.success}
                    className={SAVE_BUTTON}
                >
                    Save
                </Button>
            </div>
        </form>
    );
};
