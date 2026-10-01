import { LocaleProvider, ThemeProvider } from "@gamecrafters/base-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as outboundsApi from "@/features/outbounds/api";
import { EditOutboundDialog } from "@/features/outbounds/components/EditOutboundDialog";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EditOutboundDialog", () => {
    it("submits a renamed tag for the same outbound and preserves its options", async () => {
        const outbound = { id: 7, type: "direct", tag: "old", bind_interface: "eth0" };
        const trigger = vi.fn().mockResolvedValue({ ...outbound, tag: "new" });
        const onClose = vi.fn();

        vi.spyOn(outboundsApi, "useUpdateOutbound").mockReturnValue({
            trigger,
            isMutating: false,
            error: undefined,
        } as unknown as ReturnType<typeof outboundsApi.useUpdateOutbound>);
        vi.spyOn(outboundsApi, "useOutbounds").mockReturnValue({
            data: [outbound],
            error: undefined,
            isLoading: false,
            isValidating: false,
            mutate: vi.fn(),
        });

        render(
            <SWRConfig value={{ provider: () => new Map() }}>
                <LocaleProvider>
                    <ThemeProvider colorMode="light">
                        <EditOutboundDialog
                            outbound={outbound}
                            onClose={onClose}
                            returnFocusRef={createRef<HTMLButtonElement>()}
                        />
                    </ThemeProvider>
                </LocaleProvider>
            </SWRConfig>,
        );

        const tag = await screen.findByRole("textbox", { name: "Tag" });
        expect(tag).toBeEnabled();
        fireEvent.change(tag, { target: { value: "new" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(trigger).toHaveBeenCalledOnce());
        const submitted = trigger.mock.calls[0][0] as {
            id: number;
            changes: outboundsApi.OutboundRequest;
        };
        expect(submitted.id).toBe(7);
        expect(submitted.changes.tag).toBe("new");
        expect(JSON.parse(submitted.changes.options)).toEqual({ bind_interface: "eth0" });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
