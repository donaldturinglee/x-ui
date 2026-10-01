import { Button, IconButton, NativeSelect, Text, Tooltip } from "@gamecrafters/base-ui/react";
import { ArrowSyncRegular } from "@gamecrafters/base-ui-icons";
import { useId } from "react";
import { useWatch, type Control, type UseFormSetValue } from "react-hook-form";

import { FilledSelect, FilledTextInput } from "@/components/FilledField";

import { IDENTITIES, withIdentityDrawn, type ClientConfig, type ClientRequest } from "../api";

interface ClientCredentialsProps {
    control: Control<ClientRequest>;
    setValue: UseFormSetValue<ClientRequest>;
}

// The subscriber's credentials, one identity per protocol, laid out as the
// reference's Config tab: the button that starts them all afresh, then a row per
// protocol with its name and its own such button beside what it holds.
//
// They are drawn here, as the reference draws them: a new subscriber is given
// one of each as the dialog opens, and starting one afresh draws another at once.
// Neither is put into use until the subscriber is saved. One left empty is the
// API's to mint on the save, for the listeners that need it, and one can still be
// typed in, for a subscriber moved here whose client applications hold theirs.
export const ClientCredentials = ({ control, setValue }: ClientCredentialsProps) => {
    const baseId = useId();
    const config: ClientConfig = useWatch({ control, name: "config" }) ?? {};

    const setConfig = (next: ClientConfig) => setValue("config", next, { shouldDirty: true });
    const text = (key: string, field: string) => {
        const value = config[key]?.[field];

        return typeof value === "string" ? value : "";
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button
                    trailingVisual={ArrowSyncRegular}
                    className="h-9 rounded-[4px] border-0 bg-[var(--control-background-color-rest)] px-4 text-[14px] font-medium"
                    onClick={() => setConfig(withIdentityDrawn(config))}
                >
                    Reset all
                </Button>
                <Text className="text-[12px] text-[var(--foreground-color-muted)]">
                    Drawn afresh here, and put into use when the subscriber is saved.
                </Text>
            </div>

            {IDENTITIES.map(({ key, fields }) => (
                <div
                    key={key}
                    role="group"
                    aria-labelledby={`${baseId}-${key}`}
                    className="grid grid-cols-12 gap-2"
                >
                    <div className="col-span-12 flex items-center justify-end gap-1 min-[840px]:col-span-3">
                        <Text id={`${baseId}-${key}`} className="text-[16px] leading-6">
                            {key}
                        </Text>
                        <Tooltip text="Reset" direction="n">
                            <IconButton
                                icon={<ArrowSyncRegular size={22} />}
                                aria-label={`Reset ${key}`}
                                variant="invisible"
                                className="size-7 min-w-0 rounded-full p-0 text-[var(--foreground-color-default)]"
                                onClick={() => setConfig(withIdentityDrawn(config, key))}
                            />
                        </Tooltip>
                    </div>
                    <div className="col-span-12 flex flex-col min-[840px]:col-span-9">
                        {fields.map((field) =>
                            field.choices ? (
                                <FilledSelect
                                    key={field.name}
                                    id={`${baseId}-${key}-${field.name}`}
                                    label={field.label}
                                    value={text(key, field.name)}
                                    onChange={(event) =>
                                        setConfig({
                                            ...config,
                                            [key]: {
                                                ...config[key],
                                                [field.name]: event.target.value,
                                            },
                                        })
                                    }
                                >
                                    <NativeSelect.Option value="">None</NativeSelect.Option>
                                    {field.choices.map((choice) => (
                                        <NativeSelect.Option key={choice} value={choice}>
                                            {choice}
                                        </NativeSelect.Option>
                                    ))}
                                    {text(key, field.name) &&
                                        !field.choices.includes(text(key, field.name)) && (
                                            <NativeSelect.Option value={text(key, field.name)}>
                                                {text(key, field.name)}
                                            </NativeSelect.Option>
                                        )}
                                </FilledSelect>
                            ) : (
                                <FilledTextInput
                                    key={field.name}
                                    id={`${baseId}-${key}-${field.name}`}
                                    label={field.label}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={text(key, field.name)}
                                    onChange={(event) =>
                                        setConfig({
                                            ...config,
                                            [key]: {
                                                ...config[key],
                                                [field.name]: event.target.value,
                                            },
                                        })
                                    }
                                />
                            ),
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
};
