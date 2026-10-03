import type { SubscriptionSettings } from "./api/subscription";

export const subscriptionPublicBase = (values: SubscriptionSettings, host: string) => {
    if (values.publicUrl) return `${values.publicUrl}${values.basePath}`;
    const scheme = values.certFile && values.keyFile ? "https" : "http";
    const hostname = values.domain || host;
    const address =
        hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    const port =
        (scheme === "http" && values.port === 80) || (scheme === "https" && values.port === 443)
            ? ""
            : `:${values.port}`;
    return `${scheme}://${address}${port}${values.basePath}`;
};
