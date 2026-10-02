import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { z } from "zod";

import { request } from "@/lib/request";

// The settings endpoint carries a flat map of strings, whatever a value means.
// The panel is what knows that one of them is a count of hours and two are
// switches, which is why the forms below are typed and this is not.
export type Settings = Record<string, string>;

export const SETTINGS_KEY = "/settings";

// The keys an operator may change. The rest of what the settings table holds is
// either bookkeeping the panel writes for itself or has an endpoint of its own
// that does more than write the value -- maintenance stops service, the core
// config is validated -- and neither travels through these forms.
// Where subscribers fetch from is not here. It is subscription.public_url in
// configs/, beside the port, path and certificate that describe that listener,
// and the panel reads the assembled answer from /subscription-uri.
export const SUB_UPDATES = "subUpdates";
export const SUB_ENCODE = "subEncode";
export const SUB_SHOW_INFO = "subShowInfo";

// The subscription's own, which its tab saves and puts back to their defaults
// without touching anybody else's.
export const SUBSCRIPTION_KEYS = [SUB_UPDATES, SUB_ENCODE, SUB_SHOW_INFO];

// The most hours a subscription may be told to wait. A client that is told to
// refresh less often than once a week stops noticing that a quota was reset.
export const MAXIMUM_SUB_UPDATES = 168;

// What is checked here is the shape the API asks for rather than a second
// opinion on what a setting may be: the API is the authority, and what it
// refuses is read back from it.
export const settingsRequest = z.object({
    // Advertised to a subscription client as how often to come back, in hours.
    subUpdates: z
        .number("Use a whole number of hours.")
        .int("Use a whole number of hours.")
        .min(1, "Use at least one hour.")
        .max(MAXIMUM_SUB_UPDATES, `Use ${MAXIMUM_SUB_UPDATES} or fewer.`),
    subEncode: z.boolean(),
    subShowInfo: z.boolean(),
});

export type SettingsRequest = z.infer<typeof settingsRequest>;

// Every value arrives as a string, so what the form reads is parsed rather than
// trusted. A value that cannot be read falls back to the default the API would
// have sent, which keeps a malformed row from emptying the field it lands in.
const toNumber = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toBoolean = (value: string | undefined) => value === "true";

export const fromSettings = (settings: Settings): SettingsRequest => ({
    subUpdates: toNumber(settings[SUB_UPDATES], 12),
    subEncode: toBoolean(settings[SUB_ENCODE]),
    subShowInfo: toBoolean(settings[SUB_SHOW_INFO]),
});

// Back to the strings the table stores. Only the keys the form owns are sent:
// posting the whole map back would carry along anything the panel read but does
// not edit.
export const toSettingsPayload = (values: SettingsRequest): Settings => ({
    [SUB_UPDATES]: String(values.subUpdates),
    [SUB_ENCODE]: String(values.subEncode),
    [SUB_SHOW_INFO]: String(values.subShowInfo),
});

// The Telegram bot the panel sends its notifications through: whether it sends
// any, the token @BotFather handed out for it, the chats the notifications go to
// and which events are worth one.
export const TG_BOT_ENABLE = "tgBotEnable";
export const TG_BOT_TOKEN = "tgBotToken";
export const TG_BOT_CHAT_IDS = "tgBotChatIds";
export const TG_NOTIFY_SIGN_IN = "tgNotifySignIn";
export const TG_NOTIFY_DEPLETE = "tgNotifyDeplete";

export const TELEGRAM_KEYS = [
    TG_BOT_ENABLE,
    TG_BOT_TOKEN,
    TG_BOT_CHAT_IDS,
    TG_NOTIFY_SIGN_IN,
    TG_NOTIFY_DEPLETE,
];

// The shape @BotFather hands a token out in, and a chat's id: positive for a
// person's chat with the bot, negative for a group's.
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID = /^-?\d+$/;

export const telegramRequest = z
    .object({
        enabled: z.boolean(),
        token: z
            .string()
            .refine(
                (token) => !token || BOT_TOKEN.test(token),
                "Use the token @BotFather gave: the bot's id, a colon and a secret.",
            ),
        chats: z
            .array(z.string())
            .refine(
                (chats) => chats.every((chat) => CHAT_ID.test(chat)),
                "Use chat ids: numbers, negative for a group.",
            ),
        notifySignIn: z.boolean(),
        notifyDeplete: z.boolean(),
    })
    // A bot switched on with nothing to send with or nowhere to send to would
    // look set up and never send a thing, which the API refuses as well.
    .refine(({ enabled, token, chats }) => !enabled || (token !== "" && chats.length > 0), {
        message: "Give the bot its token and at least one chat before switching it on.",
        path: ["enabled"],
    });

export type TelegramRequest = z.infer<typeof telegramRequest>;

const toChats = (value: string | undefined) =>
    (value ?? "")
        .split(",")
        .map((chat) => chat.trim())
        .filter(Boolean);

export const fromTelegramSettings = (settings: Settings): TelegramRequest => ({
    enabled: toBoolean(settings[TG_BOT_ENABLE]),
    token: settings[TG_BOT_TOKEN] ?? "",
    chats: toChats(settings[TG_BOT_CHAT_IDS]),
    // On until switched off, as the API starts them.
    notifySignIn: settings[TG_NOTIFY_SIGN_IN] !== "false",
    notifyDeplete: settings[TG_NOTIFY_DEPLETE] !== "false",
});

export const toTelegramPayload = (values: TelegramRequest): Settings => ({
    [TG_BOT_ENABLE]: String(values.enabled),
    [TG_BOT_TOKEN]: values.token.trim(),
    [TG_BOT_CHAT_IDS]: values.chats.join(","),
    [TG_NOTIFY_SIGN_IN]: String(values.notifySignIn),
    [TG_NOTIFY_DEPLETE]: String(values.notifyDeplete),
});

export const getSettings = async () => {
    return request.get<Settings>(SETTINGS_KEY);
};

export const useSettings = () => {
    return useSWR<Settings, Error>(SETTINGS_KEY, getSettings);
};

// The settings are read under one key, so a write or a reset is asked for again
// wherever they could be read.
const useRevalidateSettings = () => {
    const { mutate } = useSWRConfig();

    return () => mutate(SETTINGS_KEY);
};

export const saveSettings = async (values: Settings) => {
    return request.post<Settings>(SETTINGS_KEY, values);
};

// `trigger` resolves with nothing rather than throwing on a rejected call, so a
// caller reads the outcome from what it hands back and the hook holds the error.
//
// The API answers a save and a reset alike with every setting as it now stands,
// and that answer is put straight into the cache: the page drops what was typed
// once it is saved, and would otherwise show the settings from before the save
// until the read that follows it came back.
//
// What is sent is the keys a tab owns, written out by that tab.
export const useSaveSettings = () => {
    const revalidate = useRevalidateSettings();

    return useSWRMutation(
        SETTINGS_KEY,
        (_key: string, { arg }: { arg: Settings }) => saveSettings(arg),
        {
            throwOnError: false,
            populateCache: true,
            onSuccess: revalidate,
        },
    );
};

// The keys named are put back to their defaults and nothing else, so one tab's
// defaults are not another's.
export const resetSettings = async (keys: string[]) => {
    return request.post<Settings>(`${SETTINGS_KEY}/reset`, { keys });
};

export const useResetSettings = (keys: string[]) => {
    const { mutate } = useSWRConfig();

    return useSWRMutation(`${SETTINGS_KEY}/reset`, () => resetSettings(keys), {
        throwOnError: false,
        onSuccess: (settings) => mutate(SETTINGS_KEY, settings),
    });
};

// A message sent to the bot's chats as they are saved, whatever the events are
// switched to, which is how a token is tried before anything depends on it. The
// API answers with a sentence, so it is said here that it went.
export const sendTelegramTest = async () => {
    await request.post<null>("/telegram/test");

    return true;
};

export const useSendTelegramTest = () => {
    return useSWRMutation("/telegram/test", () => sendTelegramTest(), { throwOnError: false });
};

// What the process read from configs/config.yaml and the environment when it
// started. Pending Panel settings are read and saved separately; nothing secret
// is in this running snapshot.
// Durations are whole seconds.
export interface StartupListener {
    listen: string;
    port: number;
    basePath: string;
    domain: string;
    certFile: string;
    keyFile: string;
    trustedProxies: string[];
}

export interface StartupSettings {
    panel: StartupListener;
    subscription: StartupListener & { enabled: boolean; publicUrl: string };
    session: { maxAgeSeconds: number; secretSet: boolean };
    worker: {
        timeLocation: string;
        depleteSpec: string;
        resetSpec: string;
        cleanupSpec: string;
        statsRetentionSeconds: number;
        statsBucketSeconds: number;
    };
    logLevel: string;
}

export const STARTUP_SETTINGS_KEY = `${SETTINGS_KEY}/startup`;

export const useStartupSettings = () => {
    return useSWR<StartupSettings, Error>(STARTUP_SETTINGS_KEY, () =>
        request.get<StartupSettings>(STARTUP_SETTINGS_KEY),
    );
};

// A duration read in the unit the reference shows it in -- minutes, days,
// seconds -- keeping a fraction that does not divide evenly rather than rounding
// it away: 90 seconds in minutes is 1.5, not 2.
export const inUnits = (seconds: number, unit: number) =>
    String(Math.round((seconds / unit) * 100) / 100);
