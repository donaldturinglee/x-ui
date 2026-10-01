import { Button, Heading, InlineMessage, NativeSelect, Text } from "@gamecrafters/base-ui/react";
import { useId, useState, type FormEvent } from "react";

import { DocLink } from "@/components/DocLink";
import { FilledSelect, FilledSwitch, FilledTextInput } from "@/components/FilledField";
import { toDocument, useBaseConfig, useSaveBaseConfig } from "@/features/config/api";
import { useOutbounds } from "@/features/outbounds/api";

import {
    EXPERIMENTAL_DOCS,
    experimentalOf,
    isExperimentalChanged,
    isPlainObject,
    withExperimental,
    type Experimental,
} from "../api/experimental";

import { FIELDS, FOOTER, GROUP_HEADING, SAVE_BUTTON } from "./layout";
import { ListField } from "./ListField";

// A field too long to read in a third of a row: the whole of one on a tablet,
// two thirds of one on anything wider.
const WIDE = "min-[600px]:col-span-2";

// The interfaces every node's core serves beside the proxy -- the cache it keeps
// between restarts, the Clash API and the V2Ray API -- a group each, headed as
// the reference heads them on its basics page.
// are on the settings page because one of them is what the panel itself
// depends on: a node's agent reads the traffic it reports from the Clash API.
//
// They are the base document's `experimental` key, so the tab edits a copy of it
// and writes the document back whole when Save is pressed, as NTP, HTTP Clients,
// rules and DNS do with their own keys. Nothing is put back to a default from
// here: the default is every interface switched off, the Clash API among them.
export const ExperimentalTab = () => {
    const cacheHeadingId = useId();
    const cachePathId = useId();
    const cacheIdId = useId();
    const clashHeadingId = useId();
    const controllerId = useId();
    const secretId = useId();
    const uiId = useId();
    const uiUrlId = useId();
    const uiDetourId = useId();
    const modeId = useId();
    const originId = useId();
    const v2rayHeadingId = useId();
    const v2rayListenId = useId();
    const statsInboundsId = useId();
    const statsOutboundsId = useId();
    const statsUsersId = useId();

    const { data: config, error: readError } = useBaseConfig();
    const { trigger: save, isMutating: isSaving, error: saveError } = useSaveBaseConfig();
    const { data: outbounds } = useOutbounds();

    // The copy being edited, which is the document's own until anything changes.
    const [draft, setDraft] = useState<Experimental | null>(null);

    const experimental = draft ?? experimentalOf(config);
    const cacheFile = isPlainObject(experimental.cache_file) ? experimental.cache_file : undefined;
    const clashApi = isPlainObject(experimental.clash_api) ? experimental.clash_api : undefined;
    const v2rayApi = isPlainObject(experimental.v2ray_api) ? experimental.v2ray_api : undefined;
    const v2rayStats = isPlainObject(v2rayApi?.stats) ? v2rayApi.stats : undefined;

    const outboundTags = (outbounds ?? []).map((outbound) => outbound.tag);

    // Nothing can be changed before the document has been read: a save made from
    // an empty copy would write the rest of the document back as nothing.
    const isReady = config !== undefined;
    const isChanged = draft !== null && isExperimentalChanged(config, draft);

    // An interface switched off is taken out of the document whole, and one
    // switched on starts where the reference starts it.
    const change = (key: string, value: Record<string, unknown> | undefined) =>
        setDraft({ ...experimental, [key]: value });

    const onSave = async (event: FormEvent) => {
        event.preventDefault();

        if (!config) {
            return;
        }

        if (await save({ document: toDocument(withExperimental(config, experimental)) })) {
            setDraft(null);
        }
    };

    return (
        <form aria-label="Experimental" onSubmit={(event) => void onSave(event)} noValidate>
            <div className="p-4">
                <Text
                    as="p"
                    className="mb-4 text-[14px] leading-5 text-[var(--foreground-color-muted)]"
                >
                    What every node's core serves beside the proxy, written into the base document
                    the nodes are configured from.{" "}
                    <DocLink href={EXPERIMENTAL_DOCS.experimental} label="Experimental" />
                </Text>

                {readError && (
                    <InlineMessage variant="critical" className="mb-4">
                        {readError.message}
                    </InlineMessage>
                )}

                {/* Each interface's fields are a group named by its heading, so
                    its Enabled is read out as the one it switches. */}
                <Heading as="h3" className={GROUP_HEADING}>
                    <span id={cacheHeadingId}>Cache file</span>{" "}
                    <DocLink href={EXPERIMENTAL_DOCS.cacheFile} label="Cache file" />
                </Heading>
                <div role="group" aria-labelledby={cacheHeadingId} className={FIELDS}>
                    <FilledSwitch
                        label="Enabled"
                        disabled={!isReady}
                        checked={cacheFile?.enabled === true}
                        onCheckedChange={(enabled) =>
                            change(
                                "cache_file",
                                enabled ? { ...(cacheFile ?? {}), enabled: true } : undefined,
                            )
                        }
                    />
                    {cacheFile?.enabled === true && (
                        <>
                            <FilledTextInput
                                id={cachePathId}
                                label="Path"
                                autoComplete="off"
                                spellCheck={false}
                                value={typeof cacheFile.path === "string" ? cacheFile.path : ""}
                                onChange={(event) =>
                                    change("cache_file", {
                                        ...cacheFile,
                                        path: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledTextInput
                                id={cacheIdId}
                                label="Cache ID"
                                autoComplete="off"
                                spellCheck={false}
                                value={
                                    typeof cacheFile.cache_id === "string" ? cacheFile.cache_id : ""
                                }
                                onChange={(event) =>
                                    change("cache_file", {
                                        ...cacheFile,
                                        cache_id: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledSwitch
                                label="Store fake IP"
                                checked={cacheFile.store_fakeip === true}
                                onCheckedChange={(store) =>
                                    change("cache_file", {
                                        ...cacheFile,
                                        store_fakeip: store || undefined,
                                    })
                                }
                            />
                        </>
                    )}
                </div>

                <Heading as="h3" className={GROUP_HEADING}>
                    <span id={clashHeadingId}>Clash API</span>{" "}
                    <DocLink href={EXPERIMENTAL_DOCS.clashApi} label="Clash API" />
                </Heading>
                <div role="group" aria-labelledby={clashHeadingId} className={FIELDS}>
                    <FilledSwitch
                        label="Enabled"
                        disabled={!isReady}
                        checked={clashApi !== undefined}
                        onCheckedChange={(enabled) =>
                            change(
                                "clash_api",
                                enabled ? { external_controller: "127.0.0.1:9090" } : undefined,
                            )
                        }
                    />
                    {/* The one interface the panel itself depends on: a node's
                        agent reads the traffic it reports from here. It is said
                        while the interface is off, which is when it is worth
                        knowing; switched on, the group is the reference's and
                        nothing more. */}
                    {!clashApi && (
                        <Text
                            as="p"
                            className="col-span-full m-0 text-[12px] text-[var(--foreground-color-muted)]"
                        >
                            A node's agent reads the traffic it reports from this API, at the
                            address its own configuration names. Switched off, the node reports
                            none.
                        </Text>
                    )}
                    {clashApi && (
                        <>
                            <FilledTextInput
                                id={controllerId}
                                label="External controller"
                                autoComplete="off"
                                spellCheck={false}
                                value={
                                    typeof clashApi.external_controller === "string"
                                        ? clashApi.external_controller
                                        : ""
                                }
                                onChange={(event) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        external_controller: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledTextInput
                                id={secretId}
                                label="Secret"
                                autoComplete="off"
                                spellCheck={false}
                                value={typeof clashApi.secret === "string" ? clashApi.secret : ""}
                                onChange={(event) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        secret: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledTextInput
                                id={uiId}
                                label="External UI"
                                autoComplete="off"
                                spellCheck={false}
                                value={
                                    typeof clashApi.external_ui === "string"
                                        ? clashApi.external_ui
                                        : ""
                                }
                                onChange={(event) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        external_ui: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledTextInput
                                id={uiUrlId}
                                label="External UI download URL"
                                className={WIDE}
                                autoComplete="off"
                                spellCheck={false}
                                value={
                                    typeof clashApi.external_ui_download_url === "string"
                                        ? clashApi.external_ui_download_url
                                        : ""
                                }
                                onChange={(event) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        external_ui_download_url: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledSelect
                                id={uiDetourId}
                                label="External UI download detour"
                                value={
                                    typeof clashApi.external_ui_download_detour === "string"
                                        ? clashApi.external_ui_download_detour
                                        : ""
                                }
                                onChange={(event) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        external_ui_download_detour:
                                            event.target.value || undefined,
                                    })
                                }
                            >
                                <NativeSelect.Option value="">Default</NativeSelect.Option>
                                {outboundTags.map((tag) => (
                                    <NativeSelect.Option key={tag} value={tag}>
                                        {tag}
                                    </NativeSelect.Option>
                                ))}
                            </FilledSelect>
                            <FilledTextInput
                                id={modeId}
                                label="Default mode"
                                autoComplete="off"
                                spellCheck={false}
                                value={
                                    typeof clashApi.default_mode === "string"
                                        ? clashApi.default_mode
                                        : ""
                                }
                                onChange={(event) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        default_mode: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledSwitch
                                label="Allow private network"
                                checked={clashApi.access_control_allow_private_network === true}
                                onCheckedChange={(allow) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        access_control_allow_private_network: allow || undefined,
                                    })
                                }
                            />
                            <ListField
                                id={originId}
                                label="Allowed origins, comma separated"
                                className={WIDE}
                                items={clashApi.access_control_allow_origin}
                                onChange={(origins) =>
                                    change("clash_api", {
                                        ...clashApi,
                                        access_control_allow_origin: origins.length
                                            ? origins
                                            : undefined,
                                    })
                                }
                            />
                        </>
                    )}
                </div>

                <Heading as="h3" className={GROUP_HEADING}>
                    <span id={v2rayHeadingId}>V2Ray API</span>{" "}
                    <DocLink href={EXPERIMENTAL_DOCS.v2rayApi} label="V2Ray API" />
                </Heading>
                <div role="group" aria-labelledby={v2rayHeadingId} className={FIELDS}>
                    <FilledSwitch
                        label="Enabled"
                        disabled={!isReady}
                        checked={v2rayApi !== undefined}
                        onCheckedChange={(enabled) =>
                            change(
                                "v2ray_api",
                                enabled
                                    ? {
                                          listen: "127.0.0.1:8080",
                                          stats: {
                                              enabled: false,
                                              inbounds: [],
                                              outbounds: [],
                                              users: [],
                                          },
                                      }
                                    : undefined,
                            )
                        }
                    />
                    {v2rayApi && (
                        <>
                            <FilledTextInput
                                id={v2rayListenId}
                                label="Listen"
                                autoComplete="off"
                                spellCheck={false}
                                value={typeof v2rayApi.listen === "string" ? v2rayApi.listen : ""}
                                onChange={(event) =>
                                    change("v2ray_api", {
                                        ...v2rayApi,
                                        listen: event.target.value || undefined,
                                    })
                                }
                            />
                            <FilledSwitch
                                label="Statistics"
                                checked={v2rayStats?.enabled === true}
                                onCheckedChange={(enabled) =>
                                    change("v2ray_api", {
                                        ...v2rayApi,
                                        stats: { ...(v2rayStats ?? {}), enabled },
                                    })
                                }
                            />
                        </>
                    )}
                    {v2rayApi &&
                        v2rayStats?.enabled === true &&
                        (
                            [
                                [statsInboundsId, "inbounds", "Inbounds"],
                                [statsOutboundsId, "outbounds", "Outbounds"],
                                [statsUsersId, "users", "Clients"],
                            ] as const
                        ).map(([id, key, label]) => (
                            <ListField
                                key={key}
                                id={id}
                                label={`${label}, comma separated`}
                                items={v2rayStats[key]}
                                onChange={(list) =>
                                    change("v2ray_api", {
                                        ...v2rayApi,
                                        stats: { ...v2rayStats, [key]: list },
                                    })
                                }
                            />
                        ))}
                </div>

                {saveError && (
                    <InlineMessage variant="critical" className="mt-4">
                        {saveError.message}
                    </InlineMessage>
                )}
            </div>

            {/* Save last, where a dialog keeps it, faded out until there is
                something to save. */}
            <div className={FOOTER}>
                <Button
                    type="submit"
                    variant="primary"
                    loading={isSaving}
                    disabled={!isReady || !isChanged}
                    className={SAVE_BUTTON}
                >
                    Save
                </Button>
            </div>
        </form>
    );
};
