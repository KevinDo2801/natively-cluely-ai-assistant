/**
 * Frontend Feature Flags
 *
 * Premium features have been removed from the renderer (the private
 * premium/ submodule is no longer part of this build). This flag is kept
 * as a single switch that can be flipped back if premium UI is ever
 * reintroduced; today it is permanently false.
 */

export const FEATURES = {
  /** Set to false to completely hide premium UI elements */
  PREMIUM_ENABLED: false,
} as const;
