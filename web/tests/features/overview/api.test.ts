import { describe, expect, it } from "vitest";

import {
    backupDownloadURL,
    formatBytes,
    formatPackets,
    formatUptime,
    isBackupFile,
    toUnits,
} from "@/features/overview/api";

describe("backupDownloadURL", () => {
    it("names what a backup is taken without, and nothing when it is taken whole", () => {
        expect(backupDownloadURL(["stats", "changes"])).toMatch(/\/backup\?exclude=stats,changes$/);
        expect(backupDownloadURL()).toMatch(/\/backup$/);
    });
});

describe("isBackupFile", () => {
    it("reads a file as JSON before it is sent to replace every table", async () => {
        const file = (text: string) => new File([text], "backup.json");

        expect(await isBackupFile(file('{"takenAt": 1700000000}'))).toBe(true);
        expect(await isBackupFile(file("not a backup"))).toBe(false);
    });
});

describe("formatBytes", () => {
    it("puts a unit on a count the API sends bare", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(2048)).toBe("2 KB");
        expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
        expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
    });

    it("stops climbing at the largest unit it knows", () => {
        // Beyond this the figure is meaningless anyway, and an undefined unit
        // would render as the string "undefined" beside it.
        expect(formatBytes(1024 ** 6)).toContain("PB");
    });
});

describe("toUnits", () => {
    it("splits a reading into the figure and the unit it is in", () => {
        // A gauge wears the unit as a suffix on the number, so the two are
        // handed over apart rather than written out together.
        expect(toUnits(623 * 1024 ** 2)).toEqual({ value: "623", unit: "MB" });
        expect(toUnits(4 * 1024 ** 3)).toEqual({ value: "4", unit: "GB" });
    });

    it("rounds to the unit, because a dial has no room for a decimal", () => {
        expect(toUnits(5.4 * 1024 ** 3)).toEqual({ value: "5", unit: "GB" });
    });
});

describe("formatPackets", () => {
    it("counts in thousands rather than in 1024s", () => {
        // Packets are counted rather than measured, and a network tool writes
        // them the way a count is written.
        expect(formatPackets(999)).toBe("999 p");
        expect(formatPackets(1_000)).toBe("1 Kp");
        expect(formatPackets(2_500_000)).toBe("2.5 Mp");
    });
});

describe("formatUptime", () => {
    it("reads as how long rather than as a count of seconds", () => {
        expect(formatUptime(45)).toBe("0m");
        expect(formatUptime(3_600)).toBe("1h 0m");
        expect(formatUptime(90_000)).toBe("1d 1h");
    });
});
