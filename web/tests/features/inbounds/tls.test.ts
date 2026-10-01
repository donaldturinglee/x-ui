import { describe, expect, it } from "vitest";

import {
    fromLines,
    hasTlsOption,
    randomShortIds,
    securityLabel,
    securityOf,
    startTls,
    tlsHalvesOf,
    toLines,
    withSecurity,
    withTlsHalves,
    withTlsOption,
} from "@/features/inbounds/api/tls";

describe("securityOf", () => {
    it("reads how a listener is served off the block the core takes", () => {
        expect(securityOf({ listen_port: 443 })).toBe("none");
        expect(securityOf({ tls: { enabled: true } })).toBe("tls");
        expect(securityOf({ tls: { enabled: true, reality: { enabled: true } } })).toBe("reality");
    });

    it("says a block is set up whether or not it is switched on", () => {
        // What the reference says, and what an edit would find there.
        expect(securityOf({ tls: { enabled: false } })).toBe("tls");
        expect(securityOf({ tls: { reality: { enabled: false } } })).toBe("reality");
        // Something that is not a block is not one.
        expect(securityOf({ tls: "yes" })).toBe("none");
    });

    it("is named as the field offers it", () => {
        expect(securityLabel("none")).toBe("None");
        expect(securityLabel("reality")).toBe("Reality");
    });
});

describe("tlsHalvesOf and withTlsHalves", () => {
    it("reads the halves where the listener keeps them", () => {
        expect(
            tlsHalvesOf({
                tls: { enabled: true },
                out_json: { tls: { insecure: true }, server_ports: [443] },
            }),
        ).toEqual({ server: { enabled: true }, client: { insecure: true } });
        expect(tlsHalvesOf({})).toEqual({ server: {}, client: {} });
    });

    it("writes them back beside the rest of what a client is told", () => {
        const options = { sniff: true, out_json: { server_ports: [443] } };

        expect(
            withTlsHalves(options, { server: { enabled: true }, client: { insecure: true } }),
        ).toEqual({
            sniff: true,
            tls: { enabled: true },
            out_json: { server_ports: [443], tls: { insecure: true } },
        });
    });

    it("writes no client half with nothing in it, and no out_json left with nothing", () => {
        expect(
            withTlsHalves(
                { tls: { enabled: true }, out_json: { tls: { insecure: true } } },
                { server: { enabled: true }, client: {} },
            ),
        ).toEqual({ tls: { enabled: true } });
    });

    it("takes both halves out for a listener served in the clear", () => {
        expect(
            withTlsHalves(
                { sniff: true, tls: { enabled: true }, out_json: { tls: {}, plugin: "obfs" } },
                null,
            ),
        ).toEqual({ sniff: true, out_json: { plugin: "obfs" } });
    });

    it("leaves an out_json that is not an object as it was", () => {
        expect(
            withTlsHalves({ out_json: ["kept"] }, { server: { enabled: true }, client: { a: 1 } }),
        ).toEqual({ tls: { enabled: true }, out_json: ["kept"] });
    });
});

describe("startTls and withSecurity", () => {
    it("starts plain TLS switched on and nothing more", () => {
        expect(startTls("tls")).toEqual({ server: { enabled: true }, client: {} });
        expect(withSecurity({ sniff: true }, "tls")).toEqual({
            sniff: true,
            tls: { enabled: true },
        });
    });

    it("starts Reality as the reference does", () => {
        const { server, client } = startTls("reality");

        expect(server).toMatchObject({
            enabled: true,
            server_name: "",
            reality: { enabled: true, handshake: { server_port: 443 } },
        });
        // The fingerprint it is only spoken through, and a key still to fill in.
        expect(client).toEqual({
            reality: { public_key: "" },
            utls: { enabled: true, fingerprint: "chrome" },
        });
        expect(securityOf(withSecurity({}, "reality"))).toBe("reality");
    });

    it("starts afresh, letting go of what the other had", () => {
        const reality = withSecurity({ sniff: true }, "reality");

        expect(withSecurity(reality, "tls")).toEqual({ sniff: true, tls: { enabled: true } });
        expect(withSecurity(reality, "none")).toEqual({ sniff: true });
    });
});

describe("randomShortIds", () => {
    it("draws one empty id and the rest of one to eight random bytes", () => {
        const ids = randomShortIds();

        expect(ids).toHaveLength(24);
        expect(ids[0]).toBe("");
        expect(ids.slice(1).every((id) => /^([0-9a-f]{2}){1,8}$/.test(id))).toBe(true);
    });
});

describe("TLS options", () => {
    const plain = startTls("tls");

    it("reads a group as on while any of its keys is in either half", () => {
        expect(hasTlsOption(plain, "alpn")).toBe(false);
        expect(hasTlsOption({ ...plain, client: { utls: {} } }, "utls")).toBe(true);
        // Mutual TLS is on with the client's half alone.
        expect(hasTlsOption({ ...plain, client: { client_key: [] } }, "mutual")).toBe(true);
    });

    it("starts a group switched on where the reference starts it", () => {
        expect(withTlsOption(plain, "alpn", true).server).toEqual({
            enabled: true,
            alpn: ["h3", "h2", "http/1.1"],
        });
        expect(withTlsOption(plain, "mutual", true)).toEqual({
            server: { enabled: true, client_certificate_path: [] },
            client: { client_certificate_path: "", client_key_path: "" },
        });
    });

    it("takes a group switched off out of both halves, and nothing else", () => {
        const mutual = {
            server: { enabled: true, client_authentication: "request", client_certificate: [] },
            client: { client_certificate: [], client_key: [], insecure: true },
        };

        expect(withTlsOption(mutual, "mutual", false)).toEqual({
            server: { enabled: true },
            client: { insecure: true },
        });
        // A spoof method does not outlive the name it spoofs.
        expect(
            withTlsOption(
                { ...plain, client: { spoof: "a.example", spoof_method: "wrong-ack" } },
                "spoof",
                false,
            ).client,
        ).toEqual({});
    });

    it("keeps the time difference inside the Reality block", () => {
        const reality = startTls("reality");
        const switched = withTlsOption(reality, "maxTimeDifference", true);

        expect(hasTlsOption(switched, "maxTimeDifference")).toBe(true);
        expect(switched.server.reality).toMatchObject({ max_time_difference: "1m" });
        expect(
            hasTlsOption(withTlsOption(switched, "maxTimeDifference", false), "maxTimeDifference"),
        ).toBe(false);
    });
});

describe("toLines and fromLines", () => {
    it("holds PEM text a line to an entry, as the core takes it inline", () => {
        expect(toLines("a\nb")).toEqual(["a", "b"]);
        expect(fromLines(["a", "b"])).toBe("a\nb");
        expect(fromLines(undefined)).toBe("");
    });
});
