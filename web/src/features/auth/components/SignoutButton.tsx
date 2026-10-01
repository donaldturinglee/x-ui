import { Button } from "@gamecrafters/base-ui/react";
import { SignOutRegular } from "@gamecrafters/base-ui-icons";
import { useNavigate } from "react-router";

import { useAuth } from "@/providers/auth/useAuth";
import { getRoutePath } from "@/router/routes";

export const SignoutButton = () => {
    const navigate = useNavigate();
    const { signout, isSigningOut } = useAuth();

    // The API clears the cookie either way, so this side leaves for the sign-in
    // page whether or not the call was accepted.
    const onSignout = async () => {
        await signout();
        await navigate(getRoutePath("signin"));
    };

    // Drawn as the last row of the rail rather than as a button standing apart
    // from it: flush with its edges, and with the icon where every icon above it
    // sits, so it is still there to press once the rail is down to its icons.
    return (
        <Button
            variant="invisible"
            block
            alignContent="start"
            leadingVisual={<SignOutRegular size={24} />}
            loading={isSigningOut}
            onClick={onSignout}
            className="h-10 min-w-0 overflow-hidden rounded-none border-0 px-4 text-[16px] font-normal tracking-[0.5px] focus-visible:outline-offset-[calc(-1*var(--focus-outline-width))] [&_[data-component=leadingVisual]]:mr-8"
        >
            Sign out
        </Button>
    );
};
