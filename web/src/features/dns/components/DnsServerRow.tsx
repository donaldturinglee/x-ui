import { ConfigListActions, ConfigListValue } from "@/components/ConfigList";

import { serverAddress, serverTls, type DnsServer } from "../api";

interface DnsServerRowProps {
    server: DnsServer;
    disabled: boolean;
    onEdit: (anchor: HTMLButtonElement | null) => void;
    onDelete: (anchor: HTMLButtonElement | null) => void;
}

export const DnsServerRow = ({ server, disabled, onEdit, onDelete }: DnsServerRowProps) => {
    const { address, port } = serverAddress(server);
    const tls = serverTls(server);
    const cellClass = "px-3 py-2 text-start align-middle max-[839px]:min-w-0 max-[839px]:p-0";

    return (
        <tr className="h-14 border-b border-[var(--border-color-default)] last:border-b-0 max-[839px]:grid max-[839px]:h-auto max-[839px]:grid-cols-[minmax(0,1fr)_auto] max-[839px]:items-center max-[839px]:gap-x-3 max-[839px]:gap-y-2 max-[839px]:p-3">
            <td
                data-column="Tag"
                className={`${cellClass} max-[839px]:col-start-1 max-[839px]:row-start-1`}
            >
                <div className="max-w-[220px] font-medium max-[839px]:max-w-full">
                    <ConfigListValue text={server.tag} label="DNS server tag" />
                </div>
            </td>
            <td
                data-column="Type"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-2 max-[839px]:row-start-1 max-[839px]:text-end max-[839px]:text-[var(--foreground-color-muted)]`}
            >
                <span className="block max-w-[120px] truncate" title={server.type}>
                    {server.type}
                </span>
            </td>
            <td
                data-column="Server"
                className={`${cellClass} max-[839px]:col-start-1 max-[839px]:row-start-2`}
            >
                <div className="flex items-center gap-2">
                    <span className="hidden shrink-0 text-[var(--foreground-color-muted)] max-[839px]:inline">
                        Server{" "}
                    </span>
                    <div className="max-w-[220px] min-w-0 max-[839px]:max-w-full">
                        {address === null ? (
                            "—"
                        ) : (
                            <ConfigListValue text={address} label="DNS server address" />
                        )}
                    </div>
                </div>
            </td>
            <td
                data-column="Port"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-1 max-[839px]:row-start-3`}
            >
                <span className="me-2 hidden text-[var(--foreground-color-muted)] max-[839px]:inline">
                    Port{" "}
                </span>
                {port ?? "—"}
            </td>
            <td
                data-column="TLS"
                className={`${cellClass} whitespace-nowrap max-[839px]:col-start-2 max-[839px]:row-start-3 max-[839px]:text-end`}
            >
                <span className="me-2 hidden text-[var(--foreground-color-muted)] max-[839px]:inline">
                    TLS{" "}
                </span>
                {tls === "enabled" ? "Enabled" : tls === "disabled" ? "Disabled" : "—"}
            </td>
            <td
                data-column="Actions"
                className={`${cellClass} max-[839px]:col-start-2 max-[839px]:row-start-2`}
            >
                <ConfigListActions
                    name={server.tag}
                    disabled={disabled}
                    onEdit={onEdit}
                    onDelete={onDelete}
                />
            </td>
        </tr>
    );
};
