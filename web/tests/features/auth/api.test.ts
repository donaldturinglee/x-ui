import { describe, expect, it } from "vitest";

import {
    isCodeRequired,
    normaliseCode,
    signinRequest,
    signinWithCodeRequest,
    twoFactorCodeRequest,
} from "@/features/auth/api";
import { RequestError } from "@/lib/request";

describe("signinRequest", () => {
    const credentials = { username: "operator", password: "correct-horse" };

    it("allows an empty code for password-only sign-in", () => {
        expect(signinRequest.safeParse({ ...credentials, code: "" }).success).toBe(true);
    });

    it("validates a supplied code as the digits an app shows", () => {
        expect(signinRequest.safeParse({ ...credentials, code: "123456" }).success).toBe(true);
        expect(signinRequest.safeParse({ ...credentials, code: "123 456" }).success).toBe(true);
        expect(signinRequest.safeParse({ ...credentials, code: "12345" }).success).toBe(false);
        expect(signinRequest.safeParse({ ...credentials, code: "abcdef" }).success).toBe(false);
    });
});

describe("signinWithCodeRequest", () => {
    const credentials = { username: "operator", password: "correct-horse" };

    it("requires six digits when the login page shows the code field", () => {
        for (const code of ["", "   ", "12345", "abcdef"]) {
            expect(signinWithCodeRequest.safeParse({ ...credentials, code }).success).toBe(false);
        }
        expect(signinWithCodeRequest.safeParse({ ...credentials, code: "123456" }).success).toBe(
            true,
        );
        expect(signinWithCodeRequest.safeParse({ ...credentials, code: "123 456" }).success).toBe(
            true,
        );
    });
});

describe("twoFactorCodeRequest", () => {
    it("asks for a code whatever it is for", () => {
        expect(twoFactorCodeRequest.safeParse({ code: "" }).success).toBe(false);
        expect(twoFactorCodeRequest.safeParse({ code: "654 321" }).success).toBe(true);
    });
});

describe("normaliseCode", () => {
    it("sends the digits alone", () => {
        expect(normaliseCode(" 123 456 ")).toBe("123456");
    });
});

describe("isCodeRequired", () => {
    it("reads the question the API asks in a refusal's payload", () => {
        expect(isCodeRequired(new RequestError("enter the code", 401, { twoFactor: true }))).toBe(
            true,
        );
    });

    it("takes nothing else for it, the wrong code included", () => {
        expect(isCodeRequired(new RequestError("wrong two-factor code", 401, null))).toBe(false);
        expect(isCodeRequired(new RequestError("wrong username or password", 401))).toBe(false);
        expect(isCodeRequired(new Error("offline"))).toBe(false);
        expect(isCodeRequired(null)).toBe(false);
    });
});
