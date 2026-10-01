import { Button, Clipboard, InlineMessage, SkeletonText, Text } from "@gamecrafters/base-ui/react";
import { useId } from "react";

import { FilledTextarea } from "@/components/FilledField";
import { configDownloadURL, useGeneratedConfig } from "@/features/config/api";

import { FOOTER, PLAIN_BUTTON, SAVE_BUTTON } from "./layout";

// The sing-box configuration every node fetches, as the panel assembles it now:
// the listeners and the routes out read from their tables, laid into the base
// document the Rules and DNS pages and the NTP, HTTP Clients, Experimental and
// Logs tabs edit a part of at a time. It is shown
// rather than edited, because it is not stored -- it is made again on every
// fetch from what those pages hold -- and copied or saved as a file for a node
// that is set up by hand.
export const SingBoxTab = () => {
    const documentId = useId();
    const { data: generated, error, isLoading } = useGeneratedConfig();

    // Written as the documents the panel edits are written, four spaces deep.
    const document = generated ? JSON.stringify(generated.config, null, 4) : "";

    return (
        <div>
            <div className="p-4">
                <Text
                    as="p"
                    className="mb-4 text-[14px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    What every node fetches, assembled now from the inbounds, the outbounds and the
                    base document the Rules and DNS pages and the NTP, HTTP Clients, Experimental
                    and Logs tabs edit.
                </Text>

                {error && (
                    <InlineMessage variant="critical" className="mb-4">
                        {error.message}
                    </InlineMessage>
                )}

                {/* A node reading this now is serving nobody, which is the whole
                    of what maintenance does. */}
                {generated?.maintenance && (
                    <InlineMessage variant="warning" className="mb-4">
                        Maintenance is on, so the listeners are withheld from this document.
                    </InlineMessage>
                )}

                {isLoading ? (
                    <SkeletonText lines={8} />
                ) : (
                    <FilledTextarea
                        id={documentId}
                        label="Configuration"
                        rows={20}
                        readOnly
                        spellCheck={false}
                        value={document}
                    />
                )}
            </div>

            {/* Saved by the browser from the API's own address for it, which is
                the file a node would be handed. */}
            <div className={FOOTER}>
                <Clipboard value={document} disabled={!generated}>
                    <Clipboard.Trigger className={PLAIN_BUTTON}>Copy</Clipboard.Trigger>
                </Clipboard>
                <Button
                    as="a"
                    href={configDownloadURL()}
                    download
                    variant="primary"
                    className={SAVE_BUTTON}
                >
                    Download
                </Button>
            </div>
        </div>
    );
};
