import {
    ActionList,
    ActionMenu,
    Button,
    Heading,
    IconButton,
    InlineMessage,
    NativeSelect,
} from "@gamecrafters/base-ui/react";
import { ArrowClockwiseRegular, KeyMultipleRegular } from "@gamecrafters/base-ui-icons";
import { useId, useState } from "react";
import { Controller, useWatch, type Control, type FieldErrors } from "react-hook-form";

import { ChoiceToggle } from "@/components/ChoiceToggle";
import { DocLink } from "@/components/DocLink";
import {
    FilledMultiSelect,
    FilledSelect,
    FilledSwitch,
    FilledTextarea,
    FilledTextInput,
} from "@/components/FilledField";
import { FormSection } from "@/components/FormSection";
import { generateKeypair } from "@/lib/keypair";
import { useMenuInDialog } from "@/lib/menu";

import type { InboundRequest } from "../api";
import {
    ALPN_PROTOCOLS,
    CIPHER_SUITES,
    CLIENT_AUTHENTICATIONS,
    FINGERPRINTS,
    fromLines,
    hasTlsOption,
    randomShortIds,
    ROOT_STORES,
    SECURITIES,
    SPOOF_METHODS,
    TLS_DOCS,
    TLS_OPTIONS,
    TLS_VERSIONS,
    tlsHalvesOf,
    toLines,
    withSecurity,
    withTlsHalves,
    withTlsOption,
    type TlsHalves,
    type TlsKind,
    type TlsOption,
} from "../api/tls";

interface TlsFieldsProps {
    control: Control<InboundRequest>;
    errors: FieldErrors<InboundRequest>;
    // The listener's options, which hold its TLS, and what they are handed back
    // through with it changed.
    options: Record<string, unknown>;
    onChange: (options: Record<string, unknown>) => void;
}

// A field's share of a row, the reference's: the whole of it on a phone, half
// on a tablet and a third from a laptop up; a wide one two thirds; a half one a
// half from a tablet up.
const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";
const WIDE = "col-span-12 min-[840px]:col-span-8";
const HALF = "col-span-12 min-[600px]:col-span-6";
const WHOLE = "col-span-12";

// The reference's two ways of holding a certificate or a key: a path to the file
// on the node, or the text of it in the configuration.
type Held = "path" | "text";

const HELD_CHOICES: { value: Held; label: string }[] = [
    { value: "path", label: "Use path" },
    { value: "text", label: "Use text" },
];

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const objectOf = (value: unknown) => (isObject(value) ? value : {});

const textOf = (value: unknown) => (typeof value === "string" ? value : "");

const listOf = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const without = (object: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

// The number a duration written the core's way -- "15s", "1m" -- holds, or null
// for one in any other shape.
const durationOf = (value: unknown, unit: "s" | "m") => {
    const match = typeof value === "string" ? new RegExp(`^(\\d+)${unit}$`).exec(value) : null;

    return match ? Number(match[1]) : null;
};

// How a listener is served, and with what: the block the reference puts a TLS
// configuration in, with the choice of none, TLS or Reality at its head and the
// fields of whichever was chosen under it -- the certificate and how it is
// served for TLS, the handshake borrowed and the keys for Reality -- with the
// options either switches on from its foot, and for TLS a block for encrypted
// client hellos.
//
// Every field is read off one of the two halves the listener keeps -- what it
// terminates with and what a client is handed -- and writes back into it, so
// whatever the core accepts that has no field here is carried through an edit
// as it was. Choosing another way to be served starts that one afresh, as the
// reference does.
export const TlsFields = ({ control, errors, options, onChange }: TlsFieldsProps) => {
    const securityId = useId();
    const sniId = useId();
    const minVersionId = useId();
    const maxVersionId = useId();
    const alpnId = useId();
    const cipherSuitesId = useId();
    const certificatePathId = useId();
    const keyPathId = useId();
    const certificateId = useId();
    const keyId = useId();
    const handshakeServerId = useId();
    const handshakePortId = useId();
    const privateKeyId = useId();
    const publicKeyId = useId();
    const shortIdsId = useId();
    const timeDifferenceId = useId();
    const handshakeTimeoutId = useId();
    const storeId = useId();
    const clientAuthenticationId = useId();
    const clientCaPathsId = useId();
    const clientCaId = useId();
    const clientCertificatePathId = useId();
    const clientKeyPathId = useId();
    const clientCertificateId = useId();
    const clientKeyId = useId();
    const clientPinsId = useId();
    const fingerprintId = useId();
    const spoofId = useId();
    const spoofMethodId = useId();
    const echKeyPathId = useId();
    const echKeyId = useId();
    const echQueryId = useId();
    const echConfigId = useId();

    const security = useWatch({ control, name: "security" });
    const halves = tlsHalvesOf(options);
    const { server, client } = halves;
    const reality = objectOf(server.reality);
    const handshake = objectOf(reality.handshake);
    const clientReality = objectOf(client.reality);
    const utls = objectOf(client.utls);
    const ech = objectOf(server.ech);
    const clientEch = objectOf(client.ech);
    const isEchOn = ech.enabled === true;

    // How each certificate is held is the form's choice rather than something
    // the halves say outright, since they carry either. Each opens on the way
    // the listener already holds it.
    const [certificateHeld, setCertificateHeld] = useState<Held>(
        server.key === undefined ? "path" : "text",
    );
    const [clientHeld, setClientHeld] = useState<Held>(
        server.client_certificate === undefined &&
            client.client_certificate === undefined &&
            client.client_key === undefined
            ? "path"
            : "text",
    );
    const [echHeld, setEchHeld] = useState<Held>(ech.key === undefined ? "path" : "text");
    const [generateError, setGenerateError] = useState<string>();

    const setHalves = (next: TlsHalves) => onChange(withTlsHalves(options, next));
    const setServer = (key: string, value: unknown) =>
        setHalves({ server: { ...server, [key]: value }, client });
    const setClient = (key: string, value: unknown) =>
        setHalves({ server, client: { ...client, [key]: value } });
    const setReality = (key: string, value: unknown) =>
        setServer("reality", { ...reality, [key]: value });

    const toggleOption = (option: TlsOption) => {
        const isOn = !hasTlsOption(halves, option);

        // Mutual TLS starts on paths, as the reference starts it.
        if (option === "mutual" && isOn) {
            setClientHeld("path");
        }

        setHalves(withTlsOption(halves, option, isOn));
    };

    // The certificate held one way lets go of the other, as the reference's
    // toggle does.
    const holdCertificate = (held: Held) => {
        setCertificateHeld(held);
        setHalves({
            server: without(
                server,
                held === "path" ? ["certificate", "key"] : ["certificate_path", "key_path"],
            ),
            client,
        });
    };

    const holdClientCertificates = (held: Held) => {
        setClientHeld(held);
        setHalves(
            held === "path"
                ? {
                      server: {
                          ...without(server, ["client_certificate"]),
                          client_certificate_path: [],
                      },
                      client: {
                          ...without(client, ["client_certificate", "client_key"]),
                          client_certificate_path: "",
                          client_key_path: "",
                      },
                  }
                : {
                      server: {
                          ...without(server, ["client_certificate_path"]),
                          client_certificate: [],
                      },
                      client: {
                          ...without(client, ["client_certificate_path", "client_key_path"]),
                          client_certificate: [],
                          client_key: [],
                      },
                  },
        );
    };

    const holdEchKey = (held: Held) => {
        setEchHeld(held);
        setServer("ech", without(ech, held === "path" ? ["key"] : ["key_path"]));
    };

    // Generated by the API rather than in the browser, and handed back once:
    // a self-signed certificate for the name the listener answers for, held as
    // text since there is no file of it on the node.
    const generateCertificate = async () => {
        try {
            const pair = await generateKeypair("tls", textOf(server.server_name));

            setGenerateError(undefined);
            setCertificateHeld("text");
            setHalves({
                server: {
                    ...without(server, ["certificate_path", "key_path"]),
                    certificate: toLines((pair.certificate ?? "").trim()),
                    key: toLines((pair.privateKey ?? "").trim()),
                },
                client,
            });
        } catch (error) {
            setGenerateError((error as Error).message);
        }
    };

    const generateRealityKeys = async () => {
        try {
            const pair = await generateKeypair("reality");

            setGenerateError(undefined);
            setHalves({
                server: { ...server, reality: { ...reality, private_key: pair.privateKey ?? "" } },
                client: {
                    ...client,
                    reality: { ...clientReality, public_key: pair.publicKey ?? "" },
                },
            });
        } catch (error) {
            setGenerateError((error as Error).message);
        }
    };

    return (
        <>
            <FormSection
                title="TLS"
                titleAction={<DocLink {...TLS_DOCS} />}
                hasSpacedActions
                actions={
                    security !== "none" && (
                        <TlsOptionsMenu halves={halves} kind={security} onToggle={toggleOption} />
                    )
                }
            >
                {/* Rows eight pixels apart. The one under the choice is always
                    there once TLS or Reality is chosen, empty until something in
                    it is switched on, as the reference's is. */}
                <div className="flex flex-col gap-2">
                    <div className={ROW}>
                        {/* Chosen from the three rather than typed, and starting
                            afresh when changed: TLS and Reality share a block but
                            little of what is in it. A type served only over TLS,
                            or one Reality cannot be put in front of, is refused
                            under it rather than by a node that will not start. */}
                        <Controller
                            control={control}
                            name="security"
                            render={({ field }) => (
                                <FilledSelect
                                    id={securityId}
                                    label="Security"
                                    className={FIELD}
                                    validation={errors.security?.message}
                                    ref={field.ref}
                                    value={field.value}
                                    onChange={(event) => {
                                        const next = event.target
                                            .value as InboundRequest["security"];

                                        field.onChange(next);
                                        setCertificateHeld("path");
                                        setGenerateError(undefined);
                                        onChange(withSecurity(options, next));
                                    }}
                                >
                                    {SECURITIES.map(({ value, label }) => (
                                        <NativeSelect.Option key={value} value={value}>
                                            {label}
                                        </NativeSelect.Option>
                                    ))}
                                </FilledSelect>
                            )}
                        />
                    </div>

                    {security !== "none" && (
                        <div className={ROW}>
                            {hasTlsOption(halves, "sni") && (
                                <FilledTextInput
                                    id={sniId}
                                    label="SNI"
                                    className={FIELD}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={textOf(server.server_name)}
                                    onChange={(event) =>
                                        setServer("server_name", event.target.value)
                                    }
                                />
                            )}
                            {security === "tls" && hasTlsOption(halves, "minVersion") && (
                                <FilledSelect
                                    id={minVersionId}
                                    label="Minimum version"
                                    className={FIELD}
                                    value={textOf(server.min_version)}
                                    onChange={(event) =>
                                        setServer("min_version", event.target.value)
                                    }
                                >
                                    {TLS_VERSIONS.map((version) => (
                                        <NativeSelect.Option key={version} value={version}>
                                            {version}
                                        </NativeSelect.Option>
                                    ))}
                                </FilledSelect>
                            )}
                            {security === "tls" && hasTlsOption(halves, "maxVersion") && (
                                <FilledSelect
                                    id={maxVersionId}
                                    label="Maximum version"
                                    className={FIELD}
                                    value={textOf(server.max_version)}
                                    onChange={(event) =>
                                        setServer("max_version", event.target.value)
                                    }
                                >
                                    {TLS_VERSIONS.map((version) => (
                                        <NativeSelect.Option key={version} value={version}>
                                            {version}
                                        </NativeSelect.Option>
                                    ))}
                                </FilledSelect>
                            )}
                            {security === "tls" && hasTlsOption(halves, "alpn") && (
                                <FilledMultiSelect
                                    id={alpnId}
                                    label="ALPN"
                                    className={FIELD}
                                    options={ALPN_PROTOCOLS}
                                    value={listOf(server.alpn)}
                                    onChange={(alpn) => setServer("alpn", alpn)}
                                />
                            )}
                            {security === "tls" && hasTlsOption(halves, "cipherSuites") && (
                                <FilledMultiSelect
                                    id={cipherSuitesId}
                                    label="Cipher suites"
                                    className={WIDE}
                                    options={CIPHER_SUITES}
                                    value={listOf(server.cipher_suites)}
                                    onChange={(suites) => setServer("cipher_suites", suites)}
                                />
                            )}
                        </div>
                    )}

                    {security === "tls" && (
                        <>
                            <div className="flex items-start justify-between gap-2">
                                <ChoiceToggle
                                    label="Certificate held as"
                                    choices={HELD_CHOICES}
                                    value={certificateHeld}
                                    onChange={holdCertificate}
                                />
                                <GenerateButton
                                    label="Generate a self-signed certificate"
                                    onClick={() => void generateCertificate()}
                                />
                            </div>

                            {certificateHeld === "path" ? (
                                <div className={ROW}>
                                    <FilledTextInput
                                        id={certificatePathId}
                                        label="Certificate file path"
                                        className={HALF}
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={textOf(server.certificate_path)}
                                        onChange={(event) =>
                                            setServer("certificate_path", event.target.value)
                                        }
                                    />
                                    <FilledTextInput
                                        id={keyPathId}
                                        label="Key file path"
                                        className={HALF}
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={textOf(server.key_path)}
                                        onChange={(event) =>
                                            setServer("key_path", event.target.value)
                                        }
                                    />
                                </div>
                            ) : (
                                <div className={ROW}>
                                    <FilledTextarea
                                        id={certificateId}
                                        label="Certificate"
                                        className={WHOLE}
                                        rows={5}
                                        spellCheck={false}
                                        value={fromLines(server.certificate)}
                                        onChange={(event) =>
                                            setServer("certificate", toLines(event.target.value))
                                        }
                                    />
                                    <FilledTextarea
                                        id={keyId}
                                        label="Key"
                                        className={WHOLE}
                                        rows={5}
                                        spellCheck={false}
                                        value={fromLines(server.key)}
                                        onChange={(event) =>
                                            setServer("key", toLines(event.target.value))
                                        }
                                    />
                                </div>
                            )}
                            {/* The client's half: what a client is told about
                                verifying the certificate it is shown. */}
                            <div className={ROW}>
                                <FilledSwitch
                                    label="Disable SNI"
                                    className={FIELD}
                                    checked={client.disable_sni === true}
                                    onCheckedChange={(on) =>
                                        setClient("disable_sni", on || undefined)
                                    }
                                />
                                <FilledSwitch
                                    label="Allow insecure"
                                    className={FIELD}
                                    checked={client.insecure === true}
                                    onCheckedChange={(on) => setClient("insecure", on || undefined)}
                                />
                            </div>
                        </>
                    )}

                    {security === "reality" && (
                        <>
                            <div className={ROW}>
                                <FilledTextInput
                                    id={handshakeServerId}
                                    label="Handshake server"
                                    className={FIELD}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={textOf(handshake.server)}
                                    onChange={(event) =>
                                        setReality("handshake", {
                                            ...handshake,
                                            server: event.target.value,
                                        })
                                    }
                                />
                                {/* Cleared, it is the port the reference falls
                                    back to rather than none. */}
                                <FilledTextInput
                                    id={handshakePortId}
                                    label="Server port"
                                    className={FIELD}
                                    type="number"
                                    inputMode="numeric"
                                    min={0}
                                    value={String(
                                        typeof handshake.server_port === "number" &&
                                            handshake.server_port > 0
                                            ? handshake.server_port
                                            : 443,
                                    )}
                                    onChange={(event) =>
                                        setReality("handshake", {
                                            ...handshake,
                                            server_port: Number(event.target.value) || 443,
                                        })
                                    }
                                />
                                <div className="col-span-12 flex justify-end min-[840px]:col-span-4">
                                    <GenerateButton
                                        label="Generate a Reality key pair"
                                        onClick={() => void generateRealityKeys()}
                                    />
                                </div>
                            </div>

                            <div className={ROW}>
                                <FilledTextInput
                                    id={privateKeyId}
                                    label="Private key"
                                    className={WHOLE}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={textOf(reality.private_key)}
                                    onChange={(event) =>
                                        setReality("private_key", event.target.value)
                                    }
                                />
                                <FilledTextInput
                                    id={publicKeyId}
                                    label="Public key"
                                    className={WHOLE}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={textOf(clientReality.public_key)}
                                    onChange={(event) =>
                                        setClient("reality", {
                                            ...clientReality,
                                            public_key: event.target.value,
                                        })
                                    }
                                />
                                {/* A field with the button that draws them again
                                    standing after it, as the reference's icon
                                    does. */}
                                <div className={`${WHOLE} flex items-center gap-4`}>
                                    <FilledTextInput
                                        id={shortIdsId}
                                        label="Short IDs"
                                        className="min-w-0 flex-1"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={listOf(reality.short_id).join(",")}
                                        onChange={(event) =>
                                            setReality(
                                                "short_id",
                                                event.target.value
                                                    ? event.target.value.split(",")
                                                    : [],
                                            )
                                        }
                                    />
                                    <IconButton
                                        icon={<ArrowClockwiseRegular size={20} />}
                                        aria-label="Draw new short IDs"
                                        variant="invisible"
                                        className="size-6 min-w-0 p-0 text-[var(--foreground-color-muted)]"
                                        onClick={() => setReality("short_id", randomShortIds())}
                                    />
                                </div>
                                {hasTlsOption(halves, "maxTimeDifference") && (
                                    <FilledTextInput
                                        id={timeDifferenceId}
                                        label="Max time difference (minutes)"
                                        className={FIELD}
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        value={String(
                                            durationOf(reality.max_time_difference, "m") ?? 1,
                                        )}
                                        onChange={(event) => {
                                            const minutes = Number(event.target.value);

                                            setReality(
                                                "max_time_difference",
                                                minutes > 0 ? `${minutes}m` : "1m",
                                            );
                                        }}
                                    />
                                )}
                            </div>
                        </>
                    )}

                    {generateError && (
                        <InlineMessage variant="critical">{generateError}</InlineMessage>
                    )}

                    {security !== "none" && hasTlsOption(halves, "handshakeTimeout") && (
                        <div className={ROW}>
                            <FilledTextInput
                                id={handshakeTimeoutId}
                                label="Handshake timeout (seconds)"
                                className={FIELD}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={String(durationOf(server.handshake_timeout, "s") ?? 15)}
                                onChange={(event) => {
                                    const seconds = Number(event.target.value);

                                    setServer(
                                        "handshake_timeout",
                                        seconds > 0 ? `${seconds}s` : "15s",
                                    );
                                }}
                            />
                        </div>
                    )}

                    {security === "tls" &&
                        (hasTlsOption(halves, "store") || hasTlsOption(halves, "ktls")) && (
                            <div className={ROW}>
                                {hasTlsOption(halves, "store") && (
                                    <FilledSelect
                                        id={storeId}
                                        label="Root store"
                                        className={FIELD}
                                        value={textOf(server.store)}
                                        onChange={(event) => setServer("store", event.target.value)}
                                    >
                                        {ROOT_STORES.map((store) => (
                                            <NativeSelect.Option
                                                key={store.value}
                                                value={store.value}
                                            >
                                                {store.label}
                                            </NativeSelect.Option>
                                        ))}
                                    </FilledSelect>
                                )}
                                {hasTlsOption(halves, "ktls") && (
                                    <>
                                        <FilledSwitch
                                            label="Kernel TX"
                                            className={FIELD}
                                            checked={server.kernel_tx === true}
                                            onCheckedChange={(on) => setServer("kernel_tx", on)}
                                        />
                                        <FilledSwitch
                                            label="Kernel RX"
                                            className={FIELD}
                                            checked={server.kernel_rx === true}
                                            onCheckedChange={(on) => setServer("kernel_rx", on)}
                                        />
                                    </>
                                )}
                            </div>
                        )}

                    {/* The server checks the certificates clients present, and
                        a client is handed the one it presents. */}
                    {security === "tls" && hasTlsOption(halves, "mutual") && (
                        <>
                            <div className="my-2 border-t border-[var(--border-color-default)]" />
                            <Heading
                                as="h3"
                                className="px-4 text-[14px] leading-5 font-normal tracking-[0.25px] text-[var(--foreground-color-muted)]"
                            >
                                Mutual TLS
                            </Heading>
                            <div className={`${ROW} items-center`}>
                                <FilledSelect
                                    id={clientAuthenticationId}
                                    label="Client authentication"
                                    className={FIELD}
                                    value={textOf(server.client_authentication)}
                                    onChange={(event) =>
                                        setServer(
                                            "client_authentication",
                                            event.target.value || undefined,
                                        )
                                    }
                                >
                                    <NativeSelect.Option value="">None</NativeSelect.Option>
                                    {CLIENT_AUTHENTICATIONS.map((choice) => (
                                        <NativeSelect.Option
                                            key={choice.value}
                                            value={choice.value}
                                        >
                                            {choice.label}
                                        </NativeSelect.Option>
                                    ))}
                                </FilledSelect>
                                <div className="col-span-12 flex min-[600px]:col-span-6">
                                    <ChoiceToggle
                                        label="Client certificates held as"
                                        choices={HELD_CHOICES}
                                        value={clientHeld}
                                        onChange={holdClientCertificates}
                                    />
                                </div>
                            </div>

                            {clientHeld === "path" ? (
                                <>
                                    <div className={ROW}>
                                        <FilledTextInput
                                            id={clientCaPathsId}
                                            label="Client CA paths (comma separated)"
                                            className={WHOLE}
                                            autoComplete="off"
                                            spellCheck={false}
                                            value={listOf(server.client_certificate_path).join(",")}
                                            onChange={(event) =>
                                                setServer(
                                                    "client_certificate_path",
                                                    event.target.value
                                                        ? event.target.value.split(",")
                                                        : [],
                                                )
                                            }
                                        />
                                    </div>
                                    <div className={ROW}>
                                        <FilledTextInput
                                            id={clientCertificatePathId}
                                            label="Client certificate path"
                                            className={HALF}
                                            autoComplete="off"
                                            spellCheck={false}
                                            value={textOf(client.client_certificate_path)}
                                            onChange={(event) =>
                                                setClient(
                                                    "client_certificate_path",
                                                    event.target.value,
                                                )
                                            }
                                        />
                                        <FilledTextInput
                                            id={clientKeyPathId}
                                            label="Client key path"
                                            className={HALF}
                                            autoComplete="off"
                                            spellCheck={false}
                                            value={textOf(client.client_key_path)}
                                            onChange={(event) =>
                                                setClient("client_key_path", event.target.value)
                                            }
                                        />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className={ROW}>
                                        <FilledTextarea
                                            id={clientCaId}
                                            label="Client CA certificates"
                                            className={WHOLE}
                                            rows={5}
                                            spellCheck={false}
                                            value={fromLines(server.client_certificate)}
                                            onChange={(event) =>
                                                setServer(
                                                    "client_certificate",
                                                    toLines(event.target.value),
                                                )
                                            }
                                        />
                                    </div>
                                    <div className={ROW}>
                                        <FilledTextarea
                                            id={clientCertificateId}
                                            label="Client certificate"
                                            className={WHOLE}
                                            rows={5}
                                            spellCheck={false}
                                            value={fromLines(client.client_certificate)}
                                            onChange={(event) =>
                                                setClient(
                                                    "client_certificate",
                                                    toLines(event.target.value),
                                                )
                                            }
                                        />
                                        <FilledTextarea
                                            id={clientKeyId}
                                            label="Client key"
                                            className={WHOLE}
                                            rows={5}
                                            spellCheck={false}
                                            value={fromLines(client.client_key)}
                                            onChange={(event) =>
                                                setClient("client_key", toLines(event.target.value))
                                            }
                                        />
                                    </div>
                                </>
                            )}

                            <div className={ROW}>
                                <FilledTextInput
                                    id={clientPinsId}
                                    label="Client public key SHA256 (comma separated)"
                                    className={WHOLE}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={listOf(server.client_certificate_public_key_sha256).join(
                                        ",",
                                    )}
                                    onChange={(event) =>
                                        setServer(
                                            "client_certificate_public_key_sha256",
                                            event.target.value
                                                ? event.target.value.split(",")
                                                : undefined,
                                        )
                                    }
                                />
                            </div>
                        </>
                    )}

                    {security === "tls" && hasTlsOption(halves, "utls") && (
                        <div className={ROW}>
                            <FilledSelect
                                id={fingerprintId}
                                label="Fingerprint"
                                className={FIELD}
                                value={textOf(utls.fingerprint)}
                                onChange={(event) =>
                                    setClient("utls", { ...utls, fingerprint: event.target.value })
                                }
                            >
                                {FINGERPRINTS.map((fingerprint) => (
                                    <NativeSelect.Option
                                        key={fingerprint.value}
                                        value={fingerprint.value}
                                    >
                                        {fingerprint.label}
                                    </NativeSelect.Option>
                                ))}
                            </FilledSelect>
                        </div>
                    )}

                    {/* A client alone sends it, and Reality refuses it. The core
                        refuses a method without a name to send, so the method
                        comes and goes with the name. */}
                    {security === "tls" && hasTlsOption(halves, "spoof") && (
                        <div className={ROW}>
                            <FilledTextInput
                                id={spoofId}
                                label="SNI spoof"
                                className={FIELD}
                                autoComplete="off"
                                spellCheck={false}
                                value={textOf(client.spoof)}
                                onChange={(event) => {
                                    const spoof = event.target.value;

                                    setHalves({
                                        server,
                                        client: {
                                            ...client,
                                            spoof,
                                            spoof_method: spoof
                                                ? (client.spoof_method ?? "wrong-sequence")
                                                : undefined,
                                        },
                                    });
                                }}
                            />
                            {textOf(client.spoof) && (
                                <FilledSelect
                                    id={spoofMethodId}
                                    label="Spoof method"
                                    className={FIELD}
                                    value={textOf(client.spoof_method)}
                                    onChange={(event) =>
                                        setClient("spoof_method", event.target.value)
                                    }
                                >
                                    {SPOOF_METHODS.map((method) => (
                                        <NativeSelect.Option
                                            key={method.value}
                                            value={method.value}
                                        >
                                            {method.label}
                                        </NativeSelect.Option>
                                    ))}
                                </FilledSelect>
                            )}
                        </div>
                    )}
                </div>
            </FormSection>

            {/* Encrypted client hellos: the server's key, and the config a
                client is handed to encrypt with. The reference generates the
                pair; the API has nothing that does, so they are given. Reality
                has none, and the core refuses the two together. */}
            {security === "tls" && (
                <FormSection title="ECH">
                    <div className="flex flex-col gap-2">
                        <div className={ROW}>
                            <FilledSwitch
                                label="Enable"
                                className={FIELD}
                                checked={isEchOn}
                                onCheckedChange={(on) => {
                                    setEchHeld("path");
                                    setHalves({
                                        server: {
                                            ...server,
                                            ech: on ? { enabled: true } : undefined,
                                        },
                                        client: { ...client, ech: on ? {} : undefined },
                                    });
                                }}
                            />
                        </div>

                        {isEchOn && (
                            <>
                                <div className="flex">
                                    <ChoiceToggle
                                        label="ECH key held as"
                                        choices={HELD_CHOICES}
                                        value={echHeld}
                                        onChange={holdEchKey}
                                    />
                                </div>
                                <div className={ROW}>
                                    {echHeld === "path" ? (
                                        <FilledTextInput
                                            id={echKeyPathId}
                                            label="Key file path"
                                            className={WHOLE}
                                            autoComplete="off"
                                            spellCheck={false}
                                            value={textOf(ech.key_path)}
                                            onChange={(event) =>
                                                setServer("ech", {
                                                    ...ech,
                                                    key_path: event.target.value,
                                                })
                                            }
                                        />
                                    ) : (
                                        <FilledTextarea
                                            id={echKeyId}
                                            label="Key"
                                            className={WHOLE}
                                            rows={5}
                                            spellCheck={false}
                                            value={fromLines(ech.key)}
                                            onChange={(event) =>
                                                setServer("ech", {
                                                    ...ech,
                                                    key: toLines(event.target.value),
                                                })
                                            }
                                        />
                                    )}
                                </div>
                                <div className={ROW}>
                                    <FilledTextInput
                                        id={echQueryId}
                                        label="ECH query server name"
                                        className={HALF}
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={textOf(clientEch.query_server_name)}
                                        onChange={(event) =>
                                            setClient("ech", {
                                                ...clientEch,
                                                query_server_name: event.target.value,
                                            })
                                        }
                                    />
                                </div>
                                <div className={ROW}>
                                    <FilledTextarea
                                        id={echConfigId}
                                        label="ECH config"
                                        className={WHOLE}
                                        rows={5}
                                        spellCheck={false}
                                        value={fromLines(clientEch.config)}
                                        onChange={(event) =>
                                            setClient("ech", {
                                                ...clientEch,
                                                config: toLines(event.target.value),
                                            })
                                        }
                                    />
                                </div>
                            </>
                        )}
                    </div>
                </FormSection>
            )}
        </>
    );
};

interface GenerateButtonProps {
    label: string;
    onClick: () => void;
}

// The reference's small round button that has the API generate what the fields
// beside it hold.
const GenerateButton = ({ label, onClick }: GenerateButtonProps) => {
    return (
        <IconButton
            icon={<KeyMultipleRegular size={16} />}
            aria-label={label}
            className="size-7 min-w-0 shrink-0 rounded-full border-0 bg-[var(--control-background-color-rest)] p-0"
            onClick={onClick}
        />
    );
};

interface TlsOptionsMenuProps {
    halves: TlsHalves;
    kind: TlsKind;
    onToggle: (option: TlsOption) => void;
}

// The reference's button that switches the groups of options on and off, those
// of the kind the listener is served with. The menu stays open while they are
// switched, as the reference's does, and Escape puts the menu away without the
// dialog it stands in.
const TlsOptionsMenu = ({ halves, kind, onToggle }: TlsOptionsMenuProps) => {
    const { anchorRef, isOpen, setIsOpen, onKeyDown } = useMenuInDialog();

    return (
        <div onKeyDown={onKeyDown}>
            <ActionMenu open={isOpen} onOpenChange={setIsOpen} anchorRef={anchorRef}>
                <ActionMenu.Anchor>
                    <Button className="h-9 min-w-16 rounded-[4px] border-0 bg-[var(--control-background-color-rest)] px-2 text-[14px] font-medium">
                        TLS options
                    </Button>
                </ActionMenu.Anchor>

                <ActionMenu.Overlay side="outside-left" align="center">
                    <ActionList selectionVariant="multiple">
                        {TLS_OPTIONS.filter(({ kinds }) => kinds.includes(kind)).map(
                            ({ option, label }) => (
                                <ActionList.Item
                                    key={option}
                                    selected={hasTlsOption(halves, option)}
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        onToggle(option);
                                    }}
                                >
                                    {label}
                                </ActionList.Item>
                            ),
                        )}
                    </ActionList>
                </ActionMenu.Overlay>
            </ActionMenu>
        </div>
    );
};
