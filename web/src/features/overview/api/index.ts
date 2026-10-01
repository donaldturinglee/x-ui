import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";

import { request } from "@/lib/request";
import { settings } from "@/settings";

// A current-against-total pair, in bytes.
export interface Usage {
    current: number;
    total: number;
}

// What the panel process and its host are doing.
//
// Every section is optional on purpose. A reading the API could not take is left
// out rather than sent as zero, because zero disk usage and unknown disk usage
// look identical on a dashboard and mean opposite things. What failed is named
// in `warnings`.
export interface SystemStatus {
    app: {
        name: string;
        version: string;
        go: string;
        os: string;
        arch: string;
        goroutines: number;
        heapBytes: number;
        uptimeSeconds: number;
        maintenance: boolean;
    };
    host?: {
        hostname: string;
        platform: string;
        cpus: number;
        cpuModel?: string;
        bootTime: number;
    };
    cpuPercent?: number;
    memory?: Usage;
    swap?: Usage;
    disk?: Usage;
    network?: {
        bytesSent: number;
        bytesRecv: number;
        packetsSent: number;
        packetsRecv: number;
    };
    database?: Record<string, number>;
    warnings?: string[];
}

// What has moved traffic recently, by resource.
export interface Onlines {
    inbound: string[];
    outbound: string[];
    client: string[];
}

export const SYSTEM_KEY = "/system";
export const ONLINES_KEY = "/onlines";
export const MAINTENANCE_KEY = "/maintenance";

// A panel left open on a wall should not be showing figures from an hour ago,
// and these are the two reads where that matters.
const LIVE_REFRESH_MS = 10_000;

export const getSystemStatus = async () => {
    return request.get<SystemStatus>(SYSTEM_KEY);
};

export const useSystemStatus = () => {
    return useSWR<SystemStatus, Error>(SYSTEM_KEY, getSystemStatus, {
        refreshInterval: LIVE_REFRESH_MS,
    });
};

export const getOnlines = async () => {
    return request.get<Onlines>(ONLINES_KEY);
};

// No interval of its own: the live poll carries onlines on every pass and writes
// them straight into this key, so a second timer here would be the same question
// asked twice.
export const useOnlines = () => {
    return useSWR<Onlines, Error>(ONLINES_KEY, getOnlines);
};

// Whether service is withheld on purpose, as the API answers both the read and the
// write.
export interface Maintenance {
    maintenance: boolean;
}

export const getMaintenance = async () => {
    return request.get<Maintenance>(MAINTENANCE_KEY);
};

// Read on every page rather than only where it is switched, because a panel in
// maintenance is serving nobody wherever an operator happens to be looking. No
// interval of its own: the live poll carries the flag on every pass and writes it
// straight into this key, the way it does onlines.
export const useMaintenance = () => {
    return useSWR<Maintenance, Error>(MAINTENANCE_KEY, getMaintenance);
};

export const setMaintenance = async (enable: boolean) => {
    return request.post<Maintenance>(MAINTENANCE_KEY, { enable });
};

// Turning maintenance on withholds every listener from the configuration nodes
// fetch, so the status read is asked for again: what it says about maintenance
// is the same fact from the other end, and the two disagreeing is exactly what
// an operator must not see here. The flag every page reads is written from the
// answer rather than left for the next poll, for the same reason.
export const useSetMaintenance = () => {
    const { mutate } = useSWRConfig();

    return useSWRMutation(
        MAINTENANCE_KEY,
        (_key: string, { arg }: { arg: boolean }) => setMaintenance(arg),
        {
            throwOnError: false,
            onSuccess: (result) => {
                void mutate(MAINTENANCE_KEY, result, false);
                void mutate(SYSTEM_KEY);
            },
        },
    );
};

// A copy of everything the panel holds, taken and put back from here as the
// reference does it. It is a logical export rather than a file copy: a JSON
// document of every table, which a restore replaces the data with in one
// transaction, so an unreadable file leaves what is there untouched rather than
// half-replaced.
export const BACKUP_KEY = "/backup";

// What a backup can be taken without. Both are history rather than
// configuration: a panel restored from a file that left them out comes back with
// every subscriber and listener it had, and without the traffic figures and the
// change log behind them.
export type BackupExclusion = "stats" | "changes";

// Taken through the browser rather than fetched, because the browser is what
// should save it and the session is a cookie the request carries on its own.
export const backupDownloadURL = (exclude: BackupExclusion[] = []) => {
    const query = exclude.length ? `?exclude=${exclude.join(",")}` : "";

    return `${settings.baseURL}${BACKUP_KEY}${query}`;
};

// Whether a file reads as JSON at all, checked in the browser before it is sent:
// the endpoint replaces every table, and should not be reached by a file that
// was never a backup.
export const isBackupFile = async (file: File) => {
    try {
        JSON.parse(await file.text());

        return true;
    } catch {
        return false;
    }
};

// Everything the panel holds, credentials included. Restoring replaces the
// operator accounts too, so whoever runs it signs in next with the backup's
// credentials rather than their own.
//
// The file goes up as it is, in the one field of a form the API reads a restore
// from: a JSON body is refused. The API answers a restore with nothing of its
// own, so it is said here that one landed, for the dialog to act on.
export const restoreBackup = async (file: File) => {
    const form = new FormData();

    form.append("backup", file);
    await request.post<null>(`${BACKUP_KEY}/restore`, form);

    return true;
};

// `trigger` resolves with nothing rather than throwing on a rejected call, so a
// caller reads the outcome from what it hands back and the hook holds the error.
export const useRestoreBackup = () => {
    return useSWRMutation(
        `${BACKUP_KEY}/restore`,
        (_key: string, { arg }: { arg: File }) => restoreBackup(arg),
        { throwOnError: false },
    );
};

// Bytes are counted rather than formatted by the API, so the unit is put on
// them here. A formatter is built once rather than once per row it reads.
const byteFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

// The figure and the unit it is in, before either is written out. Stopping at
// the largest unit it knows is deliberate: beyond that the number means nothing
// anyway, and an undefined unit would be written out as the word.
const scaleBytes = (bytes: number) => {
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return { value, unit: BYTE_UNITS[unit] };
};

export const formatBytes = (bytes: number) => {
    const { value, unit } = scaleBytes(bytes);

    return `${byteFormat.format(value)} ${unit}`;
};

// The same reading split rather than written out, for the one place there is
// room for a figure but not for a sentence: a gauge wears the unit as a suffix
// on the number and rounds to it, because 623MB/4GB has to fit inside the dial.
export const toUnits = (bytes: number) => {
    const { value, unit } = scaleBytes(bytes);

    return { value: Math.round(value).toString(), unit };
};

// Packets are counted rather than measured, so they climb in thousands rather
// than in 1024s, and are written the way a network tool writes them.
export const formatPackets = (packets: number) => {
    const units = ["p", "Kp", "Mp", "Gp"];

    let value = packets;
    let unit = 0;

    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }

    return `${byteFormat.format(value)} ${units[unit]}`;
};

// An uptime is read as how long the process has been up rather than as a count
// of seconds, which is what the API counts it in.
export const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
};
