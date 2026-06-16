// Selfie capture for the zone-approval flow. Wraps expo-image-picker
// behind a single function that returns a base64 data URL ready to be
// POSTed to the backend as photo_url (TEXT column).
//
// Real S3 presign + signed-URL upload is the next step here — see the
// runbook in docs/runbooks/zone_approval_flow.md. Inline base64 is the
// temporary hand-off so the smoke test works end-to-end without
// adding storage infra mid-flight.

import * as ImagePicker from 'expo-image-picker';
import { Linking, Alert } from 'react-native';
import { t } from '../i18n';

export interface CapturedPhoto {
  /** Local file:// URI from expo-image-picker — for preview <Image>. */
  uri: string;
  /** base64-encoded JPEG including the data: prefix — used as photo_url. */
  dataUrl: string;
  /** Approximate compressed size in bytes. */
  sizeBytes: number;
}

// The backend mounts Fiber with a 4 MB BodyLimit (cmd/api/main.go). The
// selfie is sent inline as base64 inside a JSON body, so the raw image
// must stay well under that after the ~33% base64 expansion + JSON
// overhead. Cap the raw bytes at ~2.6 MB so the encoded payload lands
// safely below 4 MB. (Proper ~1080px downscale via expo-image-manipulator
// is deferred — that module isn't in the binary and adding it needs a
// native prebuild.)
const MAX_SELFIE_BYTES = 2_600_000;

/**
 * Returns a captured selfie or null. Handles the permission prompt and
 * the cancellation path. Rejected permissions trigger a settings-deeplink
 * modal; everything else returns null silently so callers don't need to
 * sprinkle error toasts.
 */
export async function captureSelfieForApproval(): Promise<CapturedPhoto | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (perm.status !== 'granted') {
    showOpenSettings();
    return null;
  }

  const result = await ImagePicker.launchCameraAsync({
    // Lower quality (0.4) shrinks the JPEG so a high-res front camera is
    // far less likely to exceed the backend BodyLimit and 413.
    quality: 0.4,
    base64: true,
    allowsEditing: false,
    cameraType: ImagePicker.CameraType.front,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) return null;

  const asset = result.assets[0];
  const base64 = asset.base64;
  if (!base64) return null;

  const mime = asset.mimeType ?? 'image/jpeg';
  const dataUrl = `data:${mime};base64,${base64}`;
  // base64 expands the source by ~33% — bytes ≈ base64.length × 3/4.
  const sizeBytes = Math.floor((base64.length * 3) / 4);

  // Guard against the 413: if the still-large image would blow the
  // BodyLimit, fail with a clear message instead of a confusing network
  // error after the POST is rejected server-side.
  if (sizeBytes > MAX_SELFIE_BYTES) {
    Alert.alert(t('zoneApproval.photoRequired'), t('zoneApproval.photoTooLarge'));
    return null;
  }

  return { uri: asset.uri, dataUrl, sizeBytes };
}

function showOpenSettings() {
  // Hindi-default copy; English fallback comes from i18n.
  Alert.alert(
    t('zoneApproval.photoRequired'),
    'कैमरा का इस्तेमाल करने की मंज़ूरी दें',
    [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.ok'), onPress: () => Linking.openSettings() },
    ],
  );
}
