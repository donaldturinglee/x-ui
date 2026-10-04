import { expect, test, type Page } from "@playwright/test";

import { mockApi } from "./fixtures/api";

const signOut = async (page: Page) => {
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    const openNavigation = page.getByRole("button", { name: "Open navigation" });
    if (await openNavigation.isVisible()) {
        await openNavigation.click();
    }
    await page.getByRole("button", { name: "Sign out" }).click();
};

test.describe("signing in", () => {
    test("turns a visitor away from a page that needs a session", async ({ page }) => {
        await mockApi(page, { signedIn: false, maintenance: false });

        await page.goto("/clients");

        // Replaced rather than added to the history, so going back does not land
        // on the page they were just refused.
        await expect(page).toHaveURL(/\/signin$/);
    });

    test("refuses the wrong credentials without saying which half was wrong", async ({ page }) => {
        await mockApi(page, { signedIn: false, maintenance: false });

        await page.goto("/signin");
        await expect(page.getByLabel("Username")).toBeVisible();
        await expect(page.getByLabel("Two-factor code")).toHaveCount(0);
        await page.getByLabel("Username").fill("operator");
        await page.getByLabel("Password").fill("not-the-password");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page.getByText("wrong username or password")).toBeVisible();
        await expect(page).toHaveURL(/\/signin$/);
    });

    test("says under each field what is missing from it", async ({ page }) => {
        await mockApi(page, { signedIn: false, maintenance: false });

        let attempts = 0;

        page.on("request", (request) => {
            if (request.method() === "POST" && request.url().endsWith("/api/signin")) {
                attempts += 1;
            }
        });

        await page.goto("/signin");
        await page.getByRole("button", { name: "Sign in" }).click();

        // Said on the line the reference keeps under each field, and read out
        // with the field it is about.
        await expect(page.getByLabel("Username")).toHaveAccessibleDescription(
            "Enter your username.",
        );
        await expect(page.getByLabel("Password")).toHaveAccessibleDescription(
            "Enter your password.",
        );
        await expect(page.getByLabel("Username")).toHaveAttribute("aria-invalid", "true");

        // Nothing was sent: the form knows an empty field is not a sign-in.
        expect(attempts).toBe(0);
        await expect(page).toHaveURL(/\/signin$/);
    });

    test("lets an operator in and leaves them on the overview", async ({ page }) => {
        await mockApi(page, { signedIn: false, maintenance: false });

        await page.goto("/signin");
        await page.getByLabel("Username").fill("operator");
        await page.getByLabel("Password").fill("correct-horse");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page).toHaveURL(/\/overview$/);
        await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    });

    test("shows the code before credentials and signs in with one request", async ({ page }) => {
        await mockApi(page, { signedIn: false, maintenance: false, twoFactor: true });

        const attempts: unknown[] = [];
        const configRequests: string[] = [];
        page.on("request", (request) => {
            if (request.method() === "POST" && request.url().endsWith("/api/signin")) {
                attempts.push(request.postDataJSON());
            }
            if (request.url().includes("/api/signin/config")) {
                configRequests.push(request.url());
            }
        });

        await page.goto("/signin");
        const code = page.getByLabel("Two-factor code");

        await expect(code).toBeVisible();
        await expect(code).not.toBeFocused();
        await expect(page.getByLabel("Username")).toHaveValue("");
        expect(attempts).toHaveLength(0);

        await page.getByLabel("Username").fill("operator");
        await page.getByLabel("Password").fill("correct-horse");
        await code.fill("123 456");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page).toHaveURL(/\/overview$/);
        expect(attempts).toEqual([
            { username: "operator", password: "correct-horse", code: "123456" },
        ]);
        expect(configRequests.length).toBeGreaterThan(0);
        expect(configRequests.every((url) => new URL(url).search === "")).toBe(true);
    });

    test("requires a six-digit code before submitting and refuses a wrong code", async ({
        page,
    }) => {
        await mockApi(page, { signedIn: false, maintenance: false, twoFactor: true });

        let attempts = 0;
        page.on("request", (request) => {
            if (request.method() === "POST" && request.url().endsWith("/api/signin")) {
                attempts += 1;
            }
        });

        await page.goto("/signin");
        const code = page.getByLabel("Two-factor code");
        await page.getByLabel("Username").fill("operator");
        await page.getByLabel("Password").fill("correct-horse");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(code).toHaveAccessibleDescription("Enter the six digits your app shows.");
        expect(attempts).toBe(0);

        await code.fill("12345");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(code).toHaveAttribute("aria-invalid", "true");
        expect(attempts).toBe(0);

        await code.fill("000000");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page.getByText("wrong two-factor code")).toBeVisible();
        await expect(code).toBeVisible();

        await code.fill("123456");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page).toHaveURL(/\/overview$/);
    });

    test("waits for configuration before rendering the complete form", async ({ page }) => {
        await mockApi(page, { signedIn: false, maintenance: false, twoFactor: true });
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route("**/api/signin/config", async (route) => {
            await ready;
            await route.fallback();
        });

        await page.goto("/signin");
        await expect(page.getByRole("status", { name: "Loading sign-in settings" })).toBeVisible();
        await expect(page.getByLabel("Username")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
        release();
        await expect(page.getByLabel("Username")).toBeVisible();
        await expect(page.getByLabel("Two-factor code")).toBeVisible();
    });

    test("offers a retry instead of assuming two-factor is disabled on a read failure", async ({
        page,
    }) => {
        await mockApi(page, { signedIn: false, maintenance: false, twoFactor: true });
        let reads = 0;
        await page.route("**/api/signin/config", async (route) => {
            reads += 1;
            if (reads === 1) {
                await route.fulfill({
                    status: 500,
                    contentType: "application/json",
                    body: JSON.stringify({
                        success: false,
                        msg: "internal server error",
                        obj: null,
                    }),
                });
            } else {
                await route.fallback();
            }
        });

        await page.goto("/signin");
        await expect(page.getByText("Unable to load sign-in settings. Try again.")).toBeVisible();
        await expect(page.getByLabel("Username")).toHaveCount(0);
        await page.getByRole("button", { name: "Retry" }).click();
        await expect(page.getByLabel("Two-factor code")).toBeVisible();
        expect(reads).toBe(2);
    });

    test("still asks for a code if two-factor was enabled after the page loaded", async ({
        page,
    }) => {
        const state = { signedIn: false, maintenance: false, twoFactor: false };
        await mockApi(page, state);
        await page.goto("/signin");
        await page.getByLabel("Username").fill("operator");
        await expect(page.getByLabel("Two-factor code")).toHaveCount(0);
        state.twoFactor = true;
        await page.getByLabel("Password").fill("correct-horse");
        await page.getByRole("button", { name: "Sign in" }).click();

        const code = page.getByLabel("Two-factor code");
        await expect(code).toBeFocused();
        await expect(page.getByText("enter the code from your authenticator app")).toHaveCount(0);
        await code.fill("123456");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL(/\/overview$/);
    });

    test("hides the code after two-factor is disabled and the page is refreshed", async ({
        page,
    }) => {
        const state = { signedIn: false, maintenance: false, twoFactor: true };
        await mockApi(page, state);
        await page.goto("/signin");
        await expect(page.getByLabel("Two-factor code")).toBeVisible();
        state.twoFactor = false;
        await page.reload();
        await expect(page.getByLabel("Username")).toBeVisible();
        await expect(page.getByLabel("Two-factor code")).toHaveCount(0);
        await page.getByLabel("Username").fill("operator");
        await page.getByLabel("Password").fill("correct-horse");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL(/\/overview$/);
    });

    test("reads fresh configuration when returning after signing out", async ({ page }) => {
        const state = { signedIn: false, maintenance: false, twoFactor: false };
        await mockApi(page, state);
        await page.goto("/signin");
        await page.getByLabel("Username").fill("operator");
        await page.getByLabel("Password").fill("correct-horse");
        await page.getByRole("button", { name: "Sign in" }).click();
        await expect(page).toHaveURL(/\/overview$/);
        state.twoFactor = true;
        await signOut(page);
        await expect(page).toHaveURL(/\/signin$/);
        await expect(page.getByLabel("Two-factor code")).toBeVisible();
    });

    test("signs out and stops serving the panel", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");
        await signOut(page);

        await expect(page).toHaveURL(/\/signin$/);
    });
});
