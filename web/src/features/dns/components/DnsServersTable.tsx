import { ConfigListTable } from "@/components/ConfigList";
import { keyOf } from "@/lib/rules";

import type { DnsServer } from "../api";

import { DnsServerRow } from "./DnsServerRow";

interface DnsServersTableProps {
    labelledBy: string;
    servers: DnsServer[];
    isLoading: boolean;
    hasError: boolean;
    disabled: boolean;
    onEdit: (index: number, anchor: HTMLButtonElement | null) => void;
    onDelete: (index: number, anchor: HTMLButtonElement | null) => void;
}

// The first server is the default when Final is unset, so keep document order.
export const DnsServersTable = ({
    labelledBy,
    servers,
    isLoading,
    hasError,
    disabled,
    onEdit,
    onDelete,
}: DnsServersTableProps) => (
    <ConfigListTable
        labelledBy={labelledBy}
        columns={["Tag", "Type", "Server", "Port", "TLS", "Actions"]}
        isLoading={isLoading}
        isEmpty={servers.length === 0}
        hasError={hasError}
        emptyMessage="No DNS servers yet."
    >
        {servers.map((server, index) => (
            <DnsServerRow
                key={keyOf(server)}
                server={server}
                disabled={disabled}
                onEdit={(anchor) => onEdit(index, anchor)}
                onDelete={(anchor) => onDelete(index, anchor)}
            />
        ))}
    </ConfigListTable>
);
