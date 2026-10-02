const runtime = document.getElementById("x-ui-runtime");
const basePath: string = runtime ? JSON.parse(runtime.textContent || "{}").basePath : "/";

export const settings = {
    env: import.meta.env.MODE,
    baseURL: runtime ? `${basePath}api` : import.meta.env.VITE_BASE_URL,
    basePath,
    app_title: import.meta.env.VITE_APP_TITLE,
};
