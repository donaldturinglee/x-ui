import {
    Button,
    Clipboard,
    FormControl,
    InlineMessage,
    Label,
    NumberInput,
    RelativeTime,
    SkeletonText,
    Stack,
    Text,
    TextInput,
} from "@gamecrafters/base-ui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import {
    MAXIMUM_TOKEN_DAYS,
    tokenRequest,
    useCreateToken,
    useDeleteToken,
    useTokens,
    type TokenRequest,
} from "../api";

// What a script signs in with, where a browser has a session cookie. The secret
// comes back once, from the call that mints it, and is masked everywhere after —
// so it is shown here until the operator navigates away and never again.
export const TokensPanel = () => {
    const descId = useId();
    const expiryId = useId();
    const [minted, setMinted] = useState<string | null>(null);

    const { data: tokens, error: readError, isLoading } = useTokens();
    const { trigger: create, isMutating: isCreating, error: createError } = useCreateToken();
    const { trigger: remove, isMutating: isRemoving, error: removeError } = useDeleteToken();

    const {
        register,
        control,
        handleSubmit,
        reset,
        formState: { errors },
    } = useForm<TokenRequest>({
        resolver: zodResolver(tokenRequest),
        defaultValues: { desc: "", expiryDays: 30 },
    });

    const onSubmit = handleSubmit(async (values) => {
        const token = await create(values);

        if (token) {
            setMinted(token.token);
            reset();
        }
    });

    return (
        <Stack gap="normal" className="max-w-2xl">
            {readError && <InlineMessage variant="critical">{readError.message}</InlineMessage>}

            {isLoading && <SkeletonText lines={3} />}

            {tokens &&
                (tokens.length ? (
                    <Stack gap="condensed">
                        {tokens.map((token) => (
                            <Stack
                                key={token.id}
                                direction="horizontal"
                                align="center"
                                gap="condensed"
                                wrap="wrap"
                            >
                                <Stack.Item grow className="min-w-0">
                                    <Stack gap="none">
                                        <Text weight="semibold">{token.desc}</Text>
                                        <Text size="small" className="opacity-70">
                                            {token.expiry ? (
                                                <>
                                                    Expires{" "}
                                                    <RelativeTime
                                                        date={new Date(token.expiry * 1000)}
                                                    />
                                                </>
                                            ) : (
                                                "Never expires"
                                            )}
                                        </Text>
                                    </Stack>
                                </Stack.Item>

                                <Label>{token.token}</Label>

                                <Button
                                    variant="danger"
                                    loading={isRemoving}
                                    onClick={() => void remove(token.id)}
                                >
                                    Revoke
                                </Button>
                            </Stack>
                        ))}
                    </Stack>
                ) : (
                    <Text className="opacity-70">
                        No tokens. A script has nothing to sign in with.
                    </Text>
                ))}

            {/* Shown once. The API masks it everywhere else, so leaving this
                page without copying it means minting another. */}
            {minted && (
                <InlineMessage variant="success">
                    <Stack gap="condensed">
                        <Text>
                            Copy it now — this is the only time it is shown. The listing above
                            carries a masked value and nothing else.
                        </Text>

                        <Stack direction="horizontal" align="center" gap="condensed">
                            <Stack.Item grow className="min-w-0">
                                <Text className="block truncate font-mono text-xs">{minted}</Text>
                            </Stack.Item>

                            <Clipboard value={minted} aria-label="Copy token" />
                        </Stack>
                    </Stack>
                </InlineMessage>
            )}

            <Stack as="form" aria-label="Mint a token" gap="normal" onSubmit={onSubmit} noValidate>
                <Stack direction="horizontal" gap="normal" wrap="wrap" align="start">
                    <Stack.Item grow className="min-w-48">
                        <FormControl id={descId} required>
                            <FormControl.Label>What it is for</FormControl.Label>
                            <TextInput id={descId} block autoComplete="off" {...register("desc")} />
                            {errors.desc && (
                                <FormControl.Validation variant="error">
                                    {errors.desc.message}
                                </FormControl.Validation>
                            )}
                        </FormControl>
                    </Stack.Item>

                    <Stack.Item grow className="min-w-40">
                        <FormControl id={expiryId}>
                            <FormControl.Label>Expires in (days)</FormControl.Label>
                            <Controller
                                control={control}
                                name="expiryDays"
                                render={({ field }) => (
                                    <NumberInput
                                        id={expiryId}
                                        block
                                        min={0}
                                        max={MAXIMUM_TOKEN_DAYS}
                                        value={field.value}
                                        onChange={(value) => field.onChange(value ?? 0)}
                                    />
                                )}
                            />
                            <FormControl.Caption>Zero never expires.</FormControl.Caption>
                            {errors.expiryDays && (
                                <FormControl.Validation variant="error">
                                    {errors.expiryDays.message}
                                </FormControl.Validation>
                            )}
                        </FormControl>
                    </Stack.Item>
                </Stack>

                {createError && (
                    <InlineMessage variant="critical">{createError.message}</InlineMessage>
                )}
                {removeError && (
                    <InlineMessage variant="critical">{removeError.message}</InlineMessage>
                )}

                <Stack direction="horizontal">
                    <Button type="submit" variant="primary" loading={isCreating}>
                        Mint a token
                    </Button>
                </Stack>
            </Stack>
        </Stack>
    );
};
