import { describe, expect, it } from "vitest";

import { parseSignIn } from "@/features/admins/api";

describe("parseSignIn", () => {
    it("takes the last sign-in apart as the API wrote it", () => {
        expect(parseSignIn("2026-03-14 09:00:00 203.0.113.10")).toEqual({
            date: "2026-03-14",
            time: "09:00:00",
            address: "203.0.113.10",
        });
    });

    it("keeps an IPv6 address whole", () => {
        expect(parseSignIn("2026-03-14 09:00:00 2001:db8::1")?.address).toBe("2001:db8::1");
    });

    it("says nothing for an account that has never been signed in to", () => {
        expect(parseSignIn("")).toBeNull();
        expect(parseSignIn("   ")).toBeNull();
    });

    it("says nothing of an address it was not given", () => {
        expect(parseSignIn("2026-03-14 09:00:00")?.address).toBeNull();
    });
});
