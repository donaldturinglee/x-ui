import { expect, test } from "@playwright/test";

import { defaultSettings, mockApi, type ApiState } from "./fixtures/api";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
const REPLACEMENT = "987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";

const configuredBot = (enabled = true): ApiState => ({
    signedIn: true,
    maintenance: false,
    settings: {
        ...defaultSettings,
        tgBotEnable: String(enabled),
        tgBotToken: TOKEN,
        tgBotChatIds: "1111",
    },
});

test("keeps a saved Telegram token while the input stays empty through saving and reload", async ({
    page,
}) => {
    const state = configuredBot();
    await mockApi(page, state);
    await page.goto("/general/settings?tab=telegram");

    const form = page.getByRole("form", { name: "Telegram Bot" });
    const token = form.getByLabel("Bot token");
    const save = form.getByRole("button", { name: "Save", exact: true });
    const sendTest = form.getByRole("button", { name: "Send a test message" });
    await expect(token).toBeVisible();
    await expect(token).toHaveValue("");
    await expect(save).toBeDisabled();
    await expect(sendTest).toBeEnabled();
    await expect(form).not.toContainText("Token configured");
    await expect(form).not.toContainText("Leave blank to keep");

    await token.fill("   ");
    await form.getByRole("switch", { name: "Operator sign-ins" }).press("Space");
    await expect(save).toBeEnabled();
    await expect(sendTest).toBeDisabled();
    const submitted = page.waitForRequest(
        (request) => request.url().endsWith("/api/settings") && request.method() === "POST",
    );
    await save.click();
    const payload = (await submitted).postDataJSON();
    expect(payload).not.toHaveProperty("tgBotToken");
    expect(payload).not.toHaveProperty("tgBotTokenSet");
    await expect(save).toBeDisabled();
    await expect(token).toHaveValue("");
    expect(state.settings?.tgBotToken).toBe(TOKEN);
    expect(state.settings?.tgNotifySignIn).toBe("false");

    await page.reload();
    await expect(token).toHaveValue("");
    await expect(sendTest).toBeEnabled();
    await sendTest.click();
    await expect(form).toContainText("A test message was sent to every chat.");
    expect(state.telegramTests).toBe(1);
    expect(state.settings?.tgBotToken).toBe(TOKEN);
});

test("validates a replacement and preserves it on a failed save before clearing it on success", async ({
    page,
}) => {
    const state = configuredBot();
    await mockApi(page, state);
    let refuseSave = true;
    await page.route("**/api/settings", async (route) => {
        if (route.request().method() === "POST" && refuseSave) {
            await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                    success: false,
                    msg: "Saving is temporarily unavailable.",
                    obj: null,
                }),
            });
        } else {
            await route.fallback();
        }
    });
    await page.goto("/general/settings?tab=telegram");

    const form = page.getByRole("form", { name: "Telegram Bot" });
    const token = form.getByLabel("Bot token");
    const save = form.getByRole("button", { name: "Save", exact: true });
    const sendTest = form.getByRole("button", { name: "Send a test message" });
    await token.fill("invalid-token");
    await expect(save).toBeDisabled();
    await expect(form).toContainText("Use the token @BotFather gave");
    expect(state.settings?.tgBotToken).toBe(TOKEN);

    await token.fill(` ${REPLACEMENT} `);
    await expect(save).toBeEnabled();
    await expect(sendTest).toBeDisabled();
    await save.click();
    await expect(form).toContainText("Saving is temporarily unavailable.");
    await expect(token).toHaveValue(` ${REPLACEMENT} `);
    await expect(save).toBeEnabled();
    expect(state.settings?.tgBotToken).toBe(TOKEN);

    refuseSave = false;
    const submitted = page.waitForRequest(
        (request) => request.url().endsWith("/api/settings") && request.method() === "POST",
    );
    await save.click();
    expect((await submitted).postDataJSON().tgBotToken).toBe(REPLACEMENT);
    await expect(token).toHaveValue("");
    await expect(save).toBeDisabled();
    await expect(sendTest).toBeEnabled();
    expect(state.settings?.tgBotToken).toBe(REPLACEMENT);
    await page.reload();
    await expect(token).toHaveValue("");
    await sendTest.click();
    await expect(form).toContainText("A test message was sent to every chat.");
    expect(state.telegramTests).toBe(1);
});

test("enables a configured bot without reentering its token and requires a token after reset", async ({
    page,
}) => {
    const state = configuredBot(false);
    await mockApi(page, state);
    await page.goto("/general/settings?tab=telegram");

    const form = page.getByRole("form", { name: "Telegram Bot" });
    const token = form.getByLabel("Bot token");
    const enabled = form.getByRole("switch", { name: "Enable Telegram Bot" });
    const save = form.getByRole("button", { name: "Save", exact: true });
    const sendTest = form.getByRole("button", { name: "Send a test message" });
    await expect(token).toHaveValue("");
    await expect(sendTest).toBeEnabled();
    await enabled.press("Space");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled();
    expect(state.settings?.tgBotEnable).toBe("true");
    expect(state.settings?.tgBotToken).toBe(TOKEN);

    await form.getByRole("button", { name: "Restore defaults" }).click();
    await expect(enabled).not.toBeChecked();
    await expect(sendTest).toBeDisabled();
    await expect(token).toHaveValue("");
    expect(state.settings?.tgBotToken).toBe("");
    await form.getByLabel("Chat IDs (comma separated)").fill("1111");
    await enabled.press("Space");
    await expect(save).toBeDisabled();
    await expect(form).toContainText("Give the bot its token and at least one chat");
});
