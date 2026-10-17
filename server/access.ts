// ─── Who may use the platform ──────────────────────────────────────────────
// While the platform is being tested, only administrator accounts can sign in and use it.
// Set to false when farmers or field agents should get their own accounts.
export const ADMIN_ONLY = true;

// Failed sign-in limit: after MAX_FAILED attempts for the same email or from the same address
// within WINDOW_MS, further attempts are refused until the window passes.
export const LOGIN_MAX_FAILED = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
