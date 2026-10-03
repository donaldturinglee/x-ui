import type { Client, ClientPage } from "@/features/clients/api";

// A subscriber with nothing remarkable about them, for a test to vary one field
// of rather than build one from scratch each time.
export const buildClient = (overrides: Partial<Client> = {}): Client => ({
    id: 1,
    enable: true,
    name: "alice",
    desc: "",
    group: "",
    volume: 0,
    expiry: 0,
    up: 0,
    down: 0,
    totalUp: 0,
    totalDown: 0,
    createdAt: 1_700_000_000,
    onlineAt: 0,
    delayStart: false,
    autoReset: false,
    resetDays: 0,
    nextReset: 0,
    ...overrides,
});

export const buildClientPage = (clients: Client[]): ClientPage => ({
    clients,
    total: clients.length,
    limit: 100,
    offset: 0,
});

export const GIGABYTE = 1024 ** 3;
