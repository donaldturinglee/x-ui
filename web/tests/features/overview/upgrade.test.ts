import { describe, expect, it } from "vitest";

import { isUpgradeActive, upgradeMessage, type UpgradeJob } from "@/features/overview/api/upgrade";

const job: UpgradeJob = {
    id: "a".repeat(32),
    state: "queued",
    phase: "scheduled",
    actor: "operator",
    fromVersion: "v0.0.1",
    toVersion: "v0.0.2",
    components: ["API"],
    requestedAt: "2026-10-01T00:00:00Z",
    needsRecovery: false,
};

describe("upgrade progress", () => {
    it("keeps preparation, recovery and terminal outcomes separate", () => {
        expect(isUpgradeActive(job)).toBe(true);
        expect(upgradeMessage({ ...job, state: "rolling_back" })).toContain(
            "previous version and database",
        );
        expect(isUpgradeActive({ ...job, state: "rolled_back" })).toBe(false);
        expect(upgradeMessage({ ...job, state: "rolled_back" })).toContain("v0.0.1");
        expect(upgradeMessage({ ...job, state: "succeeded" })).toContain("v0.0.2");
        expect(upgradeMessage({ ...job, state: "failed", needsRecovery: true })).toBe(
            "Upgrade requires recovery",
        );
    });
});
