// App version-check client. Hits the public backend endpoint that compares the
// installed build against the admin-set min version (crm_app_versions) and says
// whether an update is needed, whether it's mandatory, and which store to open.

import { apiFetch, CLIENT_PLATFORM, CLIENT_VERSION } from './client';
import { BASE_URL } from './config';

export type AppVersionCheck = {
  needs_update: boolean;
  force: boolean;
  message?: string;
  store_url?: string;
  min_version?: string;
};

export async function checkAppVersion(): Promise<AppVersionCheck> {
  const url =
    `${BASE_URL}/app/version-check` +
    `?platform=${encodeURIComponent(CLIENT_PLATFORM)}` +
    `&version=${encodeURIComponent(CLIENT_VERSION)}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`version check failed: ${res.status}`);
  return res.json();
}
