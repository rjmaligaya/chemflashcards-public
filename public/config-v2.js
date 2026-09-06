/**
 * config-v2.js — shared constants for v2 client modules.
 *
 * Imported by the v2 page modules and the save helpers.
 *
 * A single Cloudflare Worker serves both the static assets and the
 * /api/v2/* endpoints, so static-file requests and API requests share one
 * origin and the API calls use relative URLs.
 */

// Empty string means same-origin: fetch("/api/v2/enroll") resolves against
// the current page's origin. Set it to an absolute URL to point the client
// at a worker on a different origin.
export const WORKER_BASE = "";

// Endpoint paths under WORKER_BASE.
export const API = {
  ENROLL:           "/api/v2/enroll",
  STATUS:           "/api/v2/status",
  SESSION_COMPLETE: "/api/v2/session-complete",
  VERIFY_PASSWORD:  "/api/v2/verify-session-password",  // in-lab delayed-test gate
  EXPORT:           "/api/v2/export",      // bearer-token auth; single participant
  EXPORT_ALL:        "/api/v2/export-all",         // bearer-token auth; all participants
  LIST_PARTICIPANTS: "/api/v2/list-participants",  // bearer-token auth; roster
  // Metacognitive layer endpoints.
  COPY:               "/api/v2/copy",                   // GET no auth; POST bearer auth
  METACOG_PREDICTION: "/api/v2/metacog/prediction",     // POST, no auth (participant call)
  METACOG_FORCED:     "/api/v2/metacog/forced-choice",  // POST, no auth (participant call)
  METACOG_FAMILIARITY:"/api/v2/familiarity",            // POST, no auth (Session 0 baseline rating)
  DEBRIEF:            "/api/v2/debrief",                 // GET, no auth (participant-facing)
  // Tester edit-request (feedback) endpoint. POST is open (testers submit
  // from a DEV session); GET + /resolve are EXPORT_TOKEN-gated (admin.html).
  FEEDBACK:           "/api/v2/feedback",
};

// Returns the full request URL for an endpoint path.
export function workerUrl(path) {
  return WORKER_BASE + path;
}
