import * as Location from 'expo-location';

/**
 * getCurrentPositionAsync can hang indefinitely when the device cannot get a
 * fix (no signal, GPS toggled off mid-call). That freezes any button that
 * awaits it in its busy state — e.g. Go Online / I've arrived would spin
 * forever with no way forward. Race the read against a timeout and fall back to
 * the last known position; throw a clear, user-facing error only if neither
 * resolves, so the caller's catch can surface it and un-busy the button.
 */
export async function getPositionWithTimeout(
  timeoutMs = 10_000,
): Promise<Location.LocationObject> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error('Location timed out. Make sure location is on, then try again.')),
      timeoutMs,
    ),
  );
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      timeout,
    ]);
  } catch (err) {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 60_000 }).catch(() => null);
    if (last) return last;
    throw err instanceof Error ? err : new Error('Could not get your location. Please try again.');
  }
}
