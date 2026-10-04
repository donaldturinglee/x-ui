const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const firstAddress = (options: Record<string, unknown>) => {
    const first: unknown = Array.isArray(options.addrs) ? options.addrs[0] : undefined;

    return isObject(first) && typeof first.server === "string" ? first : null;
};

// Only the first publication is edited by this field. The remaining addresses,
// their labels and their TLS overrides stay in the options document.
export const readShareAddress = (options: Record<string, unknown>) => {
    const first = firstAddress(options);

    return first ? (first.server as string).trim() : "";
};

// URL supplies IDNA conversion for international domains. The checks around it
// keep this a domain field: no scheme, user info, port, path or IP literal.
const domainHost = (address: string): string | null => {
    if (!address || /[\s:/\\?#@%]/u.test(address)) return null;

    try {
        const host = new URL(`http://${address}`).hostname;
        const name = host.replace(/\.$/, "");

        if (name.length > 253 || /^[\d.]+$/.test(name)) return null;
        if (!name.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
            return null;
        }

        return host;
    } catch {
        return null;
    }
};

export const isShareDomain = (address: string) => domainHost(address) !== null;

export const withShareAddress = (
    options: Record<string, unknown>,
    address: string,
    port: number,
    syncPort: boolean,
): Record<string, unknown> => {
    const first = firstAddress(options);
    const current = readShareAddress(options);
    const addrs: unknown[] = Array.isArray(options.addrs) ? options.addrs : [];

    if (!address) {
        return current ? { ...options, addrs: addrs.slice(1) } : options;
    }

    if (address === current && !syncPort) return options;

    return {
        ...options,
        addrs: [
            {
                ...first,
                // Existing IP publications remain editable. New values are
                // validated as domains by the form before they reach here.
                server: domainHost(address) ?? address,
                server_port: port,
            },
            ...addrs.slice(first ? 1 : 0),
        ],
    };
};
