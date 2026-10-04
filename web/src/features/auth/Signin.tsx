import { Button, Heading, InlineMessage, SkeletonText } from "@gamecrafters/base-ui/react";
import { Navigate } from "react-router";

import { ThemeControl } from "@/components/ThemeControl";
import { useAuth } from "@/providers/auth/useAuth";
import { getRoutePath } from "@/router/routes";

import { useSigninConfig } from "./api";
import { SigninForm } from "./components/SigninForm";

export const Signin = () => {
    const { isAuthenticated } = useAuth();
    const {
        data: config,
        error: configError,
        isValidating,
        mutate: reloadConfig,
    } = useSigninConfig();

    // Somebody who already has a session has no business on this page, and
    // landing back on it after signing in would look like the sign-in failed.
    if (isAuthenticated) {
        return <Navigate to={getRoutePath("overview")} replace />;
    }

    // A card standing a little way down the page rather than in the middle of it,
    // so it does not move when the browser's own bars come and go. It is the width
    // of the page on a phone, and narrows in steps as the screen widens, which is
    // the same grid the page it leads to is laid out on.
    //
    // The distance from the top is padding rather than a margin: a margin on the
    // first thing in the page runs straight through the provider around it, which
    // then starts that far down and leaves the top of the window unpainted.
    return (
        <main className="pt-[100px]">
            <div className="mx-auto w-full p-4 min-[840px]:max-w-[700px] min-[1145px]:max-w-[1000px] min-[1545px]:max-w-[1400px] min-[2138px]:max-w-[2000px]">
                <div className="flex justify-center">
                    <div className="w-full rounded-[4px] bg-[var(--background-color-default)] shadow-[var(--shadow-resting-medium)] min-[600px]:w-[calc((100%_+_8px)_*_8_/_12_-_8px)] min-[840px]:w-[calc((100%_+_8px)_*_4_/_12_-_8px)]">
                        <Heading
                            as="h1"
                            size="medium"
                            className="px-4 py-2 text-[22px] leading-7 font-normal"
                        >
                            Sign in
                        </Heading>

                        <div className="px-4 pb-4">
                            {configError ? (
                                <div className="flex flex-col gap-2">
                                    <InlineMessage variant="critical">
                                        Unable to load sign-in settings. Try again.
                                    </InlineMessage>
                                    <Button
                                        variant="primary"
                                        block
                                        loading={isValidating}
                                        onClick={() => void reloadConfig()}
                                    >
                                        Retry
                                    </Button>
                                </div>
                            ) : !config || isValidating ? (
                                <div role="status" aria-label="Loading sign-in settings">
                                    <SkeletonText lines={6} />
                                </div>
                            ) : (
                                <SigninForm showTwoFactor={config.showTwoFactor} />
                            )}

                            {/* The theme is the browser's rather than the account's, so
                                it can be chosen before there is anyone signed in. It
                                stands where the reference's does, raised off the card,
                                at the end of the row the reference begins with its
                                choice of language; the panel is written in one, so
                                there is nothing to choose there. */}
                            <div className="mt-2 flex justify-end">
                                <ThemeControl className="shadow-[var(--shadow-resting-medium)]" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
};
