/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CRM_API_URL?: string;
  readonly VITE_MAPBOX_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
