import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";

import { swrConfig } from "@/lib/swr";
import { Router } from "@/router";

import "@/styles/main.css";

const container = document.getElementById("root");

if (!container) {
    throw new Error("Unable to find the root container.");
}

createRoot(container).render(
    <StrictMode>
        <SWRConfig value={swrConfig}>
            <Router />
        </SWRConfig>
    </StrictMode>,
);
