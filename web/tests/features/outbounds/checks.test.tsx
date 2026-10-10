import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "@/features/outbounds/api";
import { useOutboundChecks } from "@/features/outbounds/api/useOutboundChecks";

const outbound = (id: number): api.Outbound => ({ id, type: "direct", tag: `route-${id}` });
const success: api.OutboundCheckResult = { ok: true, delay: 128, error: "" };

afterEach(() => vi.restoreAllMocks());

describe("outbound checks", () => {
    it("shares individual requests and exposes loading, success and errors", async () => {
        let resolve!: (result: api.OutboundCheckResult) => void;
        const check = vi.spyOn(api, "checkOutbound").mockImplementation(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const { result } = renderHook(() => useOutboundChecks([outbound(1)], {}));
        let first!: Promise<void>;
        let duplicate!: Promise<void>;
        act(() => {
            first = result.current.check(outbound(1));
            duplicate = result.current.check(outbound(1));
        });
        expect(duplicate).toBe(first);
        expect(check).toHaveBeenCalledOnce();
        expect(result.current.results[1].loading).toBe(true);
        await act(async () => {
            resolve(success);
            await first;
        });
        expect(result.current.results[1]).toEqual({ loading: false, result: success });

        check.mockRejectedValueOnce(new Error("Request timed out"));
        await act(async () => {
            await result.current.check(outbound(1));
        });
        expect(result.current.results[1].result?.error).toBe("Request timed out");
        expect(result.current.results[1].result?.ok).toBe(false);
    });

    it("limits Test all to four requests, updates progress, and skips block", async () => {
        const resolvers = new Map<number, (result: api.OutboundCheckResult) => void>();
        const check = vi.spyOn(api, "checkOutbound").mockImplementation(
            (id) =>
                new Promise((resolve) => {
                    resolvers.set(id, resolve);
                }),
        );
        const outbounds = [
            ...Array.from({ length: 7 }, (_, index) => outbound(index + 1)),
            { id: 8, type: "block", tag: "block" },
        ];
        const { result } = renderHook(() => useOutboundChecks(outbounds, {}));
        let all!: Promise<void>;
        act(() => {
            all = result.current.testAll();
        });
        expect(check).toHaveBeenCalledTimes(4);
        expect(result.current.batch).toEqual({ running: true, completed: 0, total: 7 });
        await act(async () => {
            resolvers.get(1)!({ ok: false, delay: 0, error: "Core unavailable" });
        });
        expect(check).toHaveBeenCalledTimes(5);
        expect(result.current.batch?.completed).toBe(1);
        expect(result.current.results[1].result?.error).toBe("Core unavailable");
        for (let id = 2; id <= 7; id++) {
            await act(async () => {
                resolvers.get(id)!(success);
            });
        }
        await act(async () => {
            await all;
        });
        expect(result.current.batch).toEqual({ running: false, completed: 7, total: 7 });
        expect(check).toHaveBeenCalledTimes(7);
        expect(result.current.results[8]).toBeUndefined();
    });

    it("cancels stale checks on edits, deletion and core changes", async () => {
        const pending: {
            signal?: AbortSignal;
            resolve: (result: api.OutboundCheckResult) => void;
        }[] = [];
        vi.spyOn(api, "checkOutbound").mockImplementation(
            (_id, signal) =>
                new Promise((resolve) => {
                    pending.push({ signal, resolve });
                }),
        );
        const initial = { outbounds: [outbound(1)], config: { route: { final: "route-1" } } };
        const { result, rerender, unmount } = renderHook(
            ({ outbounds, config }) => useOutboundChecks(outbounds, config),
            { initialProps: initial },
        );
        act(() => {
            void result.current.check(outbound(1));
        });
        const edited = { ...outbound(1), tag: "edited" };
        rerender({ ...initial, outbounds: [edited] });
        expect(pending[0].signal?.aborted).toBe(true);
        expect(result.current.results).toEqual({});
        await act(async () => {
            pending[0].resolve(success);
        });
        expect(result.current.results).toEqual({});

        act(() => {
            void result.current.check(edited);
        });
        await act(async () => {
            pending[1].resolve(success);
        });
        expect(result.current.results[1].result?.delay).toBe(128);
        rerender({ ...initial, outbounds: [{ ...edited }] });
        expect(result.current.results[1].result?.delay).toBe(128);
        rerender({ outbounds: [edited], config: { route: { final: "other" } } });
        expect(result.current.results).toEqual({});

        act(() => {
            void result.current.check(edited);
        });
        rerender({ ...initial, outbounds: [] });
        expect(pending[2].signal?.aborted).toBe(true);
        expect(result.current.results).toEqual({});
        rerender(initial);
        act(() => {
            void result.current.check(outbound(1));
        });
        unmount();
        expect(pending[3].signal?.aborted).toBe(true);
        await waitFor(() => expect(pending).toHaveLength(4));
    });
});
