import { NativeSelect, Text } from "@gamecrafters/base-ui/react";
import { useId } from "react";

import {
    FilledListField,
    FilledSelect,
    FilledSwitch,
    FilledTextarea,
    FilledTextInput,
} from "@/components/FilledField";
import { FormSection } from "@/components/FormSection";

import {
    NAIVE_TLS_FIELDS,
    OUTBOUND_TYPE_FIELDS,
    optionAt,
    TLS_FIELDS,
    TLS_OPTIONAL_TYPES,
    TLS_REQUIRED_TYPES,
    TRANSPORT_FIELDS,
    TRANSPORT_TYPES,
    withOptionAt,
    type OutboundOptionField,
    type OutboundOptionIssue,
} from "../api/field-specs";

const ROW = "grid grid-cols-12 gap-2";
const FIELD = "col-span-12 min-[600px]:col-span-6 min-[840px]:col-span-4";

interface OptionFieldProps {
    spec: OutboundOptionField;
    options: Record<string, unknown>;
    onChange: (options: Record<string, unknown>) => void;
    disabled: boolean;
    issue?: OutboundOptionIssue | null;
    type: string;
}

const OptionField = ({ spec, options, onChange, disabled, issue, type }: OptionFieldProps) => {
    const id = useId();
    const value = optionAt(options, spec.path);
    const validation = issue?.path === spec.path ? issue.message : undefined;
    const set = (next: unknown) => onChange(withOptionAt(options, spec.path, next));

    if (spec.input === "select") {
        const choices = spec.choices ?? [];
        return (
            <FilledSelect
                id={id}
                label={spec.label}
                className={FIELD}
                disabled={disabled}
                validation={validation}
                value={value === undefined ? "" : String(value)}
                onChange={(event) => {
                    const chosen = choices.find((item) => String(item) === event.target.value);
                    let next = withOptionAt(options, spec.path, chosen);
                    if (type === "snell" && spec.path === "version") {
                        for (const path of chosen === 4 ? ["mode"] : ["obfs_mode", "obfs_host"]) {
                            next = withOptionAt(next, path, undefined);
                        }
                    }
                    if (type === "socks" && spec.path === "version" && chosen !== "5") {
                        next = withOptionAt(next, "password", undefined);
                    }
                    if (type === "shadowsocks" && spec.path === "plugin" && !chosen) {
                        next = withOptionAt(next, "plugin_opts", undefined);
                    }
                    if (type === "shadowtls" && spec.path === "version" && chosen === 1) {
                        next = withOptionAt(next, "password", undefined);
                    }
                    if (spec.path === "obfs.type" && chosen === undefined) {
                        next = withOptionAt(next, "obfs", undefined);
                    }
                    onChange(next);
                }}
            >
                <NativeSelect.Option value="">
                    {spec.required ? `Choose ${spec.label.toLowerCase()}` : "Use default"}
                </NativeSelect.Option>
                {choices.map((choice) => (
                    <NativeSelect.Option key={choice} value={String(choice)}>
                        {String(choice)}
                    </NativeSelect.Option>
                ))}
                {value !== undefined && !choices.some((choice) => choice === value) && (
                    <NativeSelect.Option value={String(value)}>{String(value)}</NativeSelect.Option>
                )}
            </FilledSelect>
        );
    }

    if (spec.input === "switch") {
        return (
            <FilledSwitch
                label={spec.label}
                className={FIELD}
                disabled={disabled}
                checked={value === true}
                onCheckedChange={(checked) => {
                    if (!checked && spec.path.endsWith(".enabled")) {
                        onChange(withOptionAt(options, spec.path.slice(0, -8), undefined));
                    } else {
                        set(checked || undefined);
                    }
                }}
            />
        );
    }

    if (spec.input === "list") {
        return (
            <div className={FIELD}>
                <FilledListField
                    key={`${type}-${spec.path}`}
                    id={id}
                    label={spec.label}
                    separator={spec.separator ?? ","}
                    value={value}
                    disabled={disabled}
                    onChange={(entries) => set(entries.length ? entries : undefined)}
                />
                {validation && (
                    <Text className="text-[12px] text-[var(--foreground-color-danger)]">
                        {validation}
                    </Text>
                )}
            </div>
        );
    }

    if (spec.input === "textarea") {
        return (
            <FilledTextarea
                id={id}
                label={spec.label}
                className="col-span-12"
                rows={5}
                spellCheck={false}
                disabled={disabled}
                validation={validation}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => set(event.target.value)}
            />
        );
    }

    return (
        <FilledTextInput
            id={id}
            label={spec.label}
            className={FIELD}
            type={
                spec.input === "password" ? "password" : spec.input === "number" ? "number" : "text"
            }
            inputMode={spec.input === "number" ? "numeric" : undefined}
            min={spec.input === "number" ? 0 : undefined}
            autoComplete={spec.input === "password" ? "new-password" : "off"}
            spellCheck={false}
            disabled={disabled}
            validation={validation}
            value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
            onChange={(event) =>
                set(
                    event.target.value === ""
                        ? undefined
                        : spec.input === "number"
                          ? Number(event.target.value)
                          : event.target.value,
                )
            }
        />
    );
};

interface OutboundTypeFieldsProps {
    type: string;
    options: Record<string, unknown>;
    onChange: (options: Record<string, unknown>) => void;
    disabled: boolean;
    issue?: OutboundOptionIssue | null;
}

export const OutboundTypeFields = ({
    type,
    options,
    onChange,
    disabled,
    issue,
}: OutboundTypeFieldsProps) => {
    const tls = optionAt(options, "tls");
    const tlsEnabled = optionAt(options, "tls.enabled") === true;
    const transportType = optionAt(options, "transport.type");
    const typeFields = (OUTBOUND_TYPE_FIELDS[type] ?? []).filter(
        (spec) => !spec.when || spec.when(options),
    );
    const tlsFields =
        type === "naive"
            ? NAIVE_TLS_FIELDS
            : TLS_FIELDS.filter((spec) => {
                  if (type === "hysteria" || type === "hysteria2" || type === "tuic") {
                      return (
                          !spec.path.startsWith("tls.utls") && !spec.path.startsWith("tls.reality")
                      );
                  }
                  return true;
              });
    const id = useId();

    return (
        <div className="flex flex-col gap-2">
            {typeFields.length > 0 && (
                <FormSection title={type}>
                    <div className={ROW}>
                        {typeFields.map((spec) => (
                            <OptionField
                                key={spec.path + spec.label}
                                spec={spec}
                                options={options}
                                onChange={onChange}
                                disabled={disabled}
                                issue={issue}
                                type={type}
                            />
                        ))}
                    </div>
                </FormSection>
            )}

            {(TLS_REQUIRED_TYPES.has(type) || TLS_OPTIONAL_TYPES.has(type)) && (
                <FormSection title="TLS">
                    <div className="flex flex-col gap-2">
                        {TLS_OPTIONAL_TYPES.has(type) && (
                            <FilledSwitch
                                label="Enable TLS"
                                checked={tlsEnabled}
                                disabled={disabled}
                                onCheckedChange={(checked) =>
                                    onChange(
                                        withOptionAt(
                                            options,
                                            "tls",
                                            checked
                                                ? {
                                                      ...(tls && typeof tls === "object"
                                                          ? tls
                                                          : {}),
                                                      enabled: true,
                                                  }
                                                : undefined,
                                        ),
                                    )
                                }
                            />
                        )}
                        {(tlsEnabled || TLS_REQUIRED_TYPES.has(type)) && (
                            <div className={ROW}>
                                {tlsFields
                                    .filter((spec) => !spec.when || spec.when(options))
                                    .map((spec) => (
                                        <OptionField
                                            key={spec.path}
                                            spec={spec}
                                            options={options}
                                            onChange={onChange}
                                            disabled={disabled}
                                            issue={issue}
                                            type={type}
                                        />
                                    ))}
                            </div>
                        )}
                        {issue?.path === "tls.enabled" && (
                            <Text className="text-[12px] text-[var(--foreground-color-danger)]">
                                {issue.message}
                            </Text>
                        )}
                    </div>
                </FormSection>
            )}

            {TRANSPORT_TYPES.has(type) && (
                <FormSection title="Transport">
                    <div className={ROW}>
                        <FilledSelect
                            id={id}
                            label="Transport type"
                            className={FIELD}
                            value={typeof transportType === "string" ? transportType : ""}
                            disabled={disabled}
                            onChange={(event) =>
                                onChange(
                                    withOptionAt(
                                        options,
                                        "transport",
                                        event.target.value
                                            ? { type: event.target.value }
                                            : undefined,
                                    ),
                                )
                            }
                        >
                            <NativeSelect.Option value="">None</NativeSelect.Option>
                            {["http", "ws", "quic", "grpc", "httpupgrade"].map((value) => (
                                <NativeSelect.Option key={value} value={value}>
                                    {value}
                                </NativeSelect.Option>
                            ))}
                            {typeof transportType === "string" &&
                                transportType &&
                                !["http", "ws", "quic", "grpc", "httpupgrade"].includes(
                                    transportType,
                                ) && (
                                    <NativeSelect.Option value={transportType}>
                                        {transportType}
                                    </NativeSelect.Option>
                                )}
                        </FilledSelect>
                        {TRANSPORT_FIELDS.filter((spec) => !spec.when || spec.when(options)).map(
                            (spec) => (
                                <OptionField
                                    key={`${String(transportType)}-${spec.path}`}
                                    spec={spec}
                                    options={options}
                                    onChange={onChange}
                                    disabled={disabled}
                                    issue={issue}
                                    type={type}
                                />
                            ),
                        )}
                    </div>
                </FormSection>
            )}
        </div>
    );
};
