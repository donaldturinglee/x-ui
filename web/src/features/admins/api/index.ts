import useSWR from "swr";

import type { Operator } from "@/features/auth/api";
import { request } from "@/lib/request";

// Every account the panel has, as /users lists them: the same shape /me gives
// the one signed in, password hash and all left behind.
export const USERS_KEY = "/users";

export const useUsers = () => {
    return useSWR<Operator[], Error>(USERS_KEY, () => request.get<Operator[]>(USERS_KEY));
};

// The last sign-in, taken apart for a card. The API writes it as one string --
// "2006-01-02 15:04:05 <address>" -- and it is shown the way it was written,
// with the clock it was written by, rather than read as a moment in the
// browser's time zone that it never said it was in. Null for an account that
// has never been signed in to.
export const parseSignIn = (lastSignIn: string) => {
    const [date, time, ...address] = lastSignIn.trim().split(/\s+/);

    if (!date || !time) {
        return null;
    }

    return { date, time, address: address.join(" ") || null };
};
