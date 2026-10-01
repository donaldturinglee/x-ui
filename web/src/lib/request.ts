import axios, { type AxiosError } from "axios";

import { settings } from "@/settings";

// Every endpoint answers with this envelope. `success` is what the panel
// branches on, `msg` carries the reason a call was refused, and `obj` the
// payload — so an empty result and a failed one are told apart without reading
// the status line.
export interface Envelope<T> {
    success: boolean;
    msg: string;
    obj: T;
}

// The API authenticates with a session cookie rather than a bearer token, so
// requests have to carry credentials and there is nothing for the panel to
// store. `X-Requested-With` is the marker the API's cross-site check looks for.
export const client = axios.create({
    baseURL: settings.baseURL,
    withCredentials: true,
    headers: {
        "X-Requested-With": "XMLHttpRequest",
    },
});

// A call the API refused. What it said is the message, as for any error; what
// else the refusal carried is kept beside it for the one caller that branches
// on it -- a sign-in answered with a question rather than a session.
export class RequestError extends Error {
    readonly status?: number;
    readonly obj?: unknown;

    constructor(message: string, status?: number, obj?: unknown) {
        super(message);
        this.name = "RequestError";
        this.status = status;
        this.obj = obj;
    }
}

// The reason a call was refused is inside the envelope, not in the status text,
// so it is lifted out here rather than at each call site. An error that carried
// no envelope — a proxy, a dropped connection — keeps whatever axios said.
const toError = (error: AxiosError<Envelope<unknown>>) => {
    const message = error.response?.data?.msg;

    return new RequestError(
        message?.trim() || error.message,
        error.response?.status,
        error.response?.data?.obj,
    );
};

const unwrap = async <T>(call: Promise<{ data: Envelope<T> }>) => {
    try {
        const { data } = await call;

        // A 200 carrying `success: false` is a refusal the status line does not
        // show. Reading it as success would hand the caller an empty payload
        // and no indication anything went wrong.
        if (!data.success) {
            throw new RequestError(
                data.msg?.trim() || "The request was refused.",
                undefined,
                data.obj,
            );
        }

        return data.obj;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            throw toError(error as AxiosError<Envelope<unknown>>);
        }

        throw error;
    }
};

// The API is three methods wide: an update is a POST to the record's own path
// rather than a PUT. A panel is reached through whatever sits in front of it —
// a corporate proxy, an embedded webview, a captive network's filter — and
// these are the ones those are relied on to forward.
export const request = {
    get: <T>(url: string) => unwrap<T>(client.get<Envelope<T>>(url)),
    post: <T>(url: string, body?: unknown) => unwrap<T>(client.post<Envelope<T>>(url, body)),
    delete: <T>(url: string) => unwrap<T>(client.delete<Envelope<T>>(url)),
};
