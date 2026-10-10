import { useEffect, useMemo, useState } from "react";

import { checkOutbound, refusesAll, type Outbound, type OutboundCheckResult } from ".";

export interface OutboundCheckState {
    loading: boolean;
    result?: OutboundCheckResult;
}

interface CheckSnapshot {
    results: Record<number, OutboundCheckState>;
    batch?: { running: boolean; completed: number; total: number };
}

interface PendingCheck {
    outbound: Outbound;
    controller: AbortController;
    promise: Promise<void>;
    resolve: () => void;
}

// Both individual clicks and Test all use this queue. React renders only its
// snapshots; pending promises and controllers stay outside component state.
class CheckSession {
    private active = false;
    private generation = 0;
    private running = 0;
    private results: CheckSnapshot["results"] = {};
    private batch?: CheckSnapshot["batch"];
    private pending = new Map<number, PendingCheck>();
    private queue: PendingCheck[] = [];
    private publish: (snapshot: CheckSnapshot) => void;

    constructor(publish: (snapshot: CheckSnapshot) => void) {
        this.publish = publish;
    }

    activate() {
        this.active = true;
    }

    dispose() {
        this.active = false;
        this.generation++;
        for (const pending of this.pending.values()) {
            pending.controller.abort();
            pending.resolve();
        }
        this.pending.clear();
        this.queue = [];
        this.running = 0;
        this.results = {};
        this.batch = undefined;
    }

    private notify() {
        if (this.active) this.publish({ results: { ...this.results }, batch: this.batch });
    }

    check(outbound: Outbound): Promise<void> {
        if (!this.active || refusesAll(outbound.type)) return Promise.resolve();
        const existing = this.pending.get(outbound.id);
        if (existing) return existing.promise;

        let resolve!: () => void;
        const promise = new Promise<void>((resolveCheck) => {
            resolve = resolveCheck;
        });
        const pending = { outbound, controller: new AbortController(), promise, resolve };
        this.pending.set(outbound.id, pending);
        this.queue.push(pending);
        this.results[outbound.id] = { loading: true };
        this.notify();
        this.pump();
        return promise;
    }

    private pump() {
        while (this.active && this.running < 4 && this.queue.length > 0) {
            const pending = this.queue.shift()!;
            this.running++;
            void this.run(pending, this.generation);
        }
    }

    private async run(pending: PendingCheck, generation: number) {
        let result: OutboundCheckResult;
        try {
            result = await checkOutbound(pending.outbound.id, pending.controller.signal);
        } catch (error) {
            result = {
                ok: false,
                delay: 0,
                error: error instanceof Error ? error.message : "Connection check failed.",
            };
        }
        pending.resolve();
        if (!this.active || generation !== this.generation) return;
        this.results[pending.outbound.id] = { loading: false, result };
        this.pending.delete(pending.outbound.id);
        this.running--;
        this.notify();
        this.pump();
    }

    async testAll(outbounds: Outbound[]) {
        if (!this.active || this.batch?.running) return;
        const eligible = outbounds.filter((outbound) => !refusesAll(outbound.type));
        const generation = this.generation;
        this.batch = { running: true, completed: 0, total: eligible.length };
        this.notify();
        await Promise.all(
            eligible.map(async (outbound) => {
                await this.check(outbound);
                if (!this.active || generation !== this.generation || !this.batch) return;
                this.batch = { ...this.batch, completed: this.batch.completed + 1 };
                this.notify();
            }),
        );
        if (!this.active || generation !== this.generation || !this.batch) return;
        this.batch = { ...this.batch, running: false };
        this.notify();
    }
}

// A changed outbound or core configuration creates a fresh session. The visible
// state is keyed to that revision too, so a late reply cannot repaint an edit.
export const useOutboundChecks = (outbounds: Outbound[] | undefined, config: unknown) => {
    const revision = JSON.stringify([outbounds, config]);
    const [state, setState] = useState<CheckSnapshot & { revision: string }>({
        revision,
        results: {},
    });
    const session = useMemo(
        () => new CheckSession((snapshot) => setState({ ...snapshot, revision })),
        [revision],
    );
    useEffect(() => {
        session.activate();
        return () => session.dispose();
    }, [session]);

    return {
        results: state.revision === revision ? state.results : {},
        batch: state.revision === revision ? state.batch : undefined,
        check: (outbound: Outbound) => session.check(outbound),
        testAll: () => session.testAll(outbounds ?? []),
    };
};
