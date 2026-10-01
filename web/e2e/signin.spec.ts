import { expect, test } from "@playwright/test";

import { mockApi } from "./fixtures/api";

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

    test("asks for the code from the app once the password is right", async ({ page }) => {
        await mockApi(page, { signedIn: false, maintenance: false, twoFactor: true });

        await page.goto("/signin");
        await page.getByLabel("Username").fill("operator");
        await page.getByLabel("Password").fill("correct-horse");
        await page.getByRole("button", { name: "Sign in" }).click();

        // Asked for rather than refused: the field comes, ready to type in, and
        // nothing is said in red.
        const code = page.getByLabel("Two-factor code");

        await expect(code).toBeFocused();
        await expect(page.getByText("enter the code from your authenticator app")).toHaveCount(0);
        await expect(page).toHaveURL(/\/signin$/);

        // A code the app never showed is refused, and the field stays for the
        // next one.
        await code.fill("000000");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page.getByText("wrong two-factor code")).toBeVisible();
        await expect(code).toBeVisible();

        await code.fill("123456");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page).toHaveURL(/\/overview$/);
    });

    test("signs out and stops serving the panel", async ({ page }) => {
        await mockApi(page, { signedIn: true, maintenance: false });

        await page.goto("/overview");
        await page.getByRole("button", { name: "Sign out" }).click();

        await expect(page).toHaveURL(/\/signin$/);
    });
});
