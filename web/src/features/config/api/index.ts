import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";

import { request } from "@/lib/request";
import { settings } from "@/settings";

// The base document: everything in a node's configuration that is not an object
// the panel models. DNS, route rules, log, ntp and the certificate settings all
// live here. It is not edited as a whole: each page that works in a part of it
// -- DNS, the rules, and the settings page's NTP, HTTP Clients, experimental and logs tabs
// -- reads the document, changes its own part, and writes the document back
// whole, so whatever else it holds, keys the proxy core gained after the panel
// was written among them, is carried through untouched.
export type CoreConfig = Record<string, unknown>;

export const CONFIG_BASE_KEY = "/config/base";
export const CONFIG_KEY = "/config";

const isPlainObject = (value: unknown): value is CoreConfig =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// Reads the document, or null when it is not a JSON object.
export const parseConfig = (document: string): CoreConfig | null => {
    if (!document.trim()) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(document);

        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

export const toDocument = (config: CoreConfig) => JSON.stringify(config, null, 4);

// What a save sends: the whole document, written out.
export interface ConfigRequest {
    document: string;
}

export const getBaseConfig = async () => {
    return request.get<CoreConfig>(CONFIG_BASE_KEY);
};

export const useBaseConfig = () => {
    return useSWR<CoreConfig, Error>(CONFIG_BASE_KEY, getBaseConfig);
};

const useRevalidateBaseConfig = () => {
    const { mutate } = useSWRConfig();

    return () => mutate(CONFIG_BASE_KEY);
};

// The body is the document itself rather than a wrapper, which is the one place
// the panel posts something that is not a shape of its own making.
export const saveBaseConfig = async (values: ConfigRequest) => {
    return request.post<CoreConfig>(CONFIG_BASE_KEY, parseConfig(values.document) ?? {});
};

// `trigger` resolves with nothing rather than throwing on a rejected call, so a
// caller reads the outcome from what it hands back and the hook holds the error.
//
// What the API answers with is the document as it stored it, and it is put
// straight into the cache: a page that edits one section of the document drops
// its own copy once it is saved, and without this would show the document from
// before the save until the read that follows it came back.
export const useSaveBaseConfig = () => {
    const revalidate = useRevalidateBaseConfig();

    return useSWRMutation(
        CONFIG_BASE_KEY,
        (_key: string, { arg }: { arg: ConfigRequest }) => saveBaseConfig(arg),
        {
            throwOnError: false,
            populateCache: true,
            onSuccess: revalidate,
        },
    );
};

// Where the assembled document is served from, as a file. It is a link rather
// than a fetch because the browser is what should save it, and the session is a
// cookie the request carries on its own.
export const configDownloadURL = () => `${settings.baseURL}${CONFIG_KEY}/download`;

// The document a node fetches, assembled as it is asked for, and whether its
// listeners were withheld from it for maintenance.
export interface GeneratedConfig {
    config: CoreConfig;
    maintenance: boolean;
}

export const useGeneratedConfig = () => {
    return useSWR<GeneratedConfig, Error>(CONFIG_KEY, () =>
        request.get<GeneratedConfig>(CONFIG_KEY),
    );
};
