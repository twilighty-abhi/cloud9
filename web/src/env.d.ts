// Minimal typing for Vite's build-time flag (used to keep dev fixtures out of production, #14).
interface ImportMetaEnv { readonly DEV: boolean }
interface ImportMeta { readonly env: ImportMetaEnv }
