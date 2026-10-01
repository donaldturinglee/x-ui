import { LocaleProvider, ThemeProvider } from "@gamecrafters/base-ui/react";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as clientsApi from "@/features/clients/api";

import { ClientsTable } from "@/features/clients/components/ClientsTable";

import { buildClient, buildClientPage, GIGABYTE } from "../../fixtures/clients";

// The table reads through SWR, so a cache of its own per test keeps one from
// being handed what another one fetched.
const renderTable = (node: ReactNode) =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <LocaleProvider>
                <ThemeProvider colorMode="light">{node}</ThemeProvider>
            </LocaleProvider>
        </SWRConfig>,
    );

afterEach(() => {
    vi.restoreAllMocks();
});

describe("ClientsTable", () => {
    it("lists the subscribers it was given", async () => {
        vi.spyOn(clientsApi, "useClients").mockReturnValue({
            data: buildClientPage([
                buildClient({ id: 1, name: "alice", group: "staff" }),
                buildClient({ id: 2, name: "bob", enable: false }),
            ]),
            error: undefined,
            isLoading: false,
            isValidating: false,
            mutate: vi.fn(),
        } as unknown as ReturnType<typeof clientsApi.useClients>);

        renderTable(<ClientsTable />);

        expect(await screen.findByText("alice")).toBeInTheDocument();
        expect(screen.getByText("bob")).toBeInTheDocument();
        expect(screen.getByText("staff")).toBeInTheDocument();
    });

    it("says which subscribers are switched off", async () => {
        vi.spyOn(clientsApi, "useClients").mockReturnValue({
            data: buildClientPage([buildClient({ name: "bob", enable: false })]),
            error: undefined,
            isLoading: false,
            isValidating: false,
            mutate: vi.fn(),
        } as unknown as ReturnType<typeof clientsApi.useClients>);

        renderTable(<ClientsTable />);

        // A disabled subscriber cannot connect, which is the first thing an
        // operator opening this page is looking for. It is a switch on the row,
        // the way the reference shows it, so the same control that says so is
        // the one that changes it.
        const row = (await screen.findByText("bob")).closest<HTMLElement>("tr");

        expect(row).not.toBeNull();
        expect(within(row!).getByRole("switch", { name: "Enable bob" })).not.toBeChecked();
    });

    it("names an unlimited subscriber rather than showing an empty meter", async () => {
        vi.spyOn(clientsApi, "useClients").mockReturnValue({
            data: buildClientPage([buildClient({ volume: 0, up: 5 * GIGABYTE })]),
            error: undefined,
            isLoading: false,
            isValidating: false,
            mutate: vi.fn(),
        } as unknown as ReturnType<typeof clientsApi.useClients>);

        renderTable(<ClientsTable />);

        // What was used against what may be, with no quota written as such
        // rather than as a figure of zero.
        expect(await screen.findByText("5 GB / Unlimited")).toBeInTheDocument();
    });

    it("offers every row action by the subscriber it belongs to", async () => {
        vi.spyOn(clientsApi, "useClients").mockReturnValue({
            data: buildClientPage([buildClient({ name: "alice" })]),
            error: undefined,
            isLoading: false,
            isValidating: false,
            mutate: vi.fn(),
        } as unknown as ReturnType<typeof clientsApi.useClients>);

        renderTable(<ClientsTable />);

        // Said in full so they are still told apart when read one after another
        // rather than three buttons all called "Edit".
        expect(await screen.findByLabelText("Edit alice")).toBeInTheDocument();
        expect(screen.getByLabelText("Delete alice")).toBeInTheDocument();
        expect(screen.getByLabelText("Connection links for alice")).toBeInTheDocument();
    });

    it("keeps the add button reachable when there are no subscribers", async () => {
        vi.spyOn(clientsApi, "useClients").mockReturnValue({
            data: buildClientPage([]),
            error: undefined,
            isLoading: false,
            isValidating: false,
            mutate: vi.fn(),
        } as unknown as ReturnType<typeof clientsApi.useClients>);

        renderTable(<ClientsTable />);

        // The table is left with its headers and nothing under them, the way
        // the reference leaves it, and the way to add one sits above it rather
        // than in it, so it is there when the read fails too.
        expect(await screen.findByRole("table", { name: "Subscribers" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add client" })).toBeInTheDocument();
    });

    it("says what went wrong rather than showing an empty table", async () => {
        vi.spyOn(clientsApi, "useClients").mockReturnValue({
            data: undefined,
            error: new Error("not signed in"),
            isLoading: false,
            isValidating: false,
            mutate: vi.fn(),
        } as unknown as ReturnType<typeof clientsApi.useClients>);

        renderTable(<ClientsTable />);

        expect(await screen.findByText("not signed in")).toBeInTheDocument();
    });
});
