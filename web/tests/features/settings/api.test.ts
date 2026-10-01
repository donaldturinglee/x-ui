import { describe, expect, it } from "vitest";

import {
    fromSettings,
    fromTelegramSettings,
    inUnits,
    settingsRequest,
    telegramRequest,
    toSettingsPayload,
    toTelegramPayload,
    type SettingsRequest,
    type TelegramRequest,
} from "@/features/settings/api";

const buildRequest = (overrides: Partial<SettingsRequest> = {}): SettingsRequest => ({
    subUpdates: 12,
    subEncode: true,
    subShowInfo: false,
    ...overrides,
});

describe("fromSettings", () => {
    it("reads the strings the table stores as what they mean", () => {
        // Every value arrives as a string, whatever it stands for, so the form
        // would otherwise get "false" in a checkbox — which is truthy.
        expect(
            fromSettings({
                subUpdates: "24",
                subEncode: "false",
                subShowInfo: "true",
            }),
        ).toEqual({
            subUpdates: 24,
            subEncode: false,
            subShowInfo: true,
        });
    });

    it("ignores a key the form does not own", () => {
        // The table may still hold a subURI row from before that address moved
        // to configs/. Reading it back into the form would put it on screen as
        // something an operator could change, which is how it got here.
        expect(fromSettings({ subURI: "https://stale.example.com" })).not.toHaveProperty("subURI");
    });

    it("falls back rather than emptying a field it cannot read", () => {
        // A row that is missing or unreadable must not clear the interval and
        // then save that back as the operator's choice.
        expect(fromSettings({}).subUpdates).toBe(12);
        expect(fromSettings({ subUpdates: "" }).subUpdates).toBe(12);
        expect(fromSettings({ subUpdates: "soon" }).subUpdates).toBe(12);
        expect(fromSettings({ subUpdates: "0" }).subUpdates).toBe(12);
    });
});

describe("toSettingsPayload", () => {
    it("writes every value back as a string", () => {
        expect(toSettingsPayload(buildRequest({ subUpdates: 6, subShowInfo: true }))).toEqual({
            subUpdates: "6",
            subEncode: "true",
            subShowInfo: "true",
        });
    });

    it("sends only the keys the form owns", () => {
        // Posting back everything that was read would carry along the
        // bookkeeping and the core document, which have endpoints of their own
        // — and subURI, which the API no longer knows.
        expect(Object.keys(toSettingsPayload(buildRequest())).sort()).toEqual([
            "subEncode",
            "subShowInfo",
            "subUpdates",
        ]);
    });
});

describe("settingsRequest", () => {
    it("accepts what the API would", () => {
        expect(settingsRequest.safeParse(buildRequest()).success).toBe(true);
    });

    it("refuses an interval no client would come back on", () => {
        // Below an hour is a client asked to refresh constantly; past a week it
        // stops noticing that a quota was reset.
        expect(settingsRequest.safeParse(buildRequest({ subUpdates: 0 })).success).toBe(false);
        expect(settingsRequest.safeParse(buildRequest({ subUpdates: 200 })).success).toBe(false);
        expect(settingsRequest.safeParse(buildRequest({ subUpdates: 1.5 })).success).toBe(false);
    });
});

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";

const buildTelegram = (overrides: Partial<TelegramRequest> = {}): TelegramRequest => ({
    enabled: false,
    token: "",
    chats: [],
    notifySignIn: true,
    notifyDeplete: true,
    ...overrides,
});

describe("the Telegram bot's settings", () => {
    it("read the strings the table stores as what they mean", () => {
        expect(
            fromTelegramSettings({
                tgBotEnable: "true",
                tgBotToken: TOKEN,
                tgBotChatIds: "1111,-100222",
                tgNotifySignIn: "false",
            }),
        ).toEqual({
            enabled: true,
            token: TOKEN,
            chats: ["1111", "-100222"],
            notifySignIn: false,
            // On until switched off, as the API starts it.
            notifyDeplete: true,
        });
    });

    it("are written back as the strings the table stores, and only the bot's", () => {
        expect(
            toTelegramPayload(
                buildTelegram({ enabled: true, token: ` ${TOKEN} `, chats: ["1", "2"] }),
            ),
        ).toEqual({
            tgBotEnable: "true",
            tgBotToken: TOKEN,
            tgBotChatIds: "1,2",
            tgNotifySignIn: "true",
            tgNotifyDeplete: "true",
        });
    });

    it("take a token and chats in the shapes Telegram hands them out in", () => {
        expect(telegramRequest.safeParse(buildTelegram({ token: TOKEN })).success).toBe(true);
        expect(telegramRequest.safeParse(buildTelegram({ token: "not-a-token" })).success).toBe(
            false,
        );
        expect(telegramRequest.safeParse(buildTelegram({ chats: ["@channel"] })).success).toBe(
            false,
        );
    });

    it("are not switched on with nothing to send with or nowhere to send to", () => {
        // It would look set up and never send a thing.
        expect(telegramRequest.safeParse(buildTelegram({ enabled: true })).success).toBe(false);
        expect(
            telegramRequest.safeParse(buildTelegram({ enabled: true, token: TOKEN, chats: ["1"] }))
                .success,
        ).toBe(true);
    });
});

describe("inUnits", () => {
    it("reads a duration in the unit it is shown in, fraction and all", () => {
        expect(inUnits(2_592_000, 86_400)).toBe("30");
        expect(inUnits(90, 60)).toBe("1.5");
    });
});
