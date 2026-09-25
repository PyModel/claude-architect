import type { PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";

/**
 * A complete `PlatformServices` whose named members are the test's and whose
 * remaining members are the real platform's.
 *
 * Recovery takes the platform whole because bound-directory cleanup spawns a
 * native helper on Windows. Recovery used to declare a three-method `Pick` and
 * then rebuild a full service object at `recoverStaleRuns`, grafting the
 * caller's members onto the selected platform -- production code whose only
 * purpose was to complete an incomplete test double. Completing the double is
 * the test's job, so it happens here.
 */
export function platformServicesDouble(
  overrides: Partial<PlatformServices>,
): PlatformServices {
  // Prototype delegation, not a spread: the platform services are class
  // instances, so their methods are not own properties.
  return Object.assign(
    Object.create(getPlatformServices()) as PlatformServices,
    overrides,
  );
}
