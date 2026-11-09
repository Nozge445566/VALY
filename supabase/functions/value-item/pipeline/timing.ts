/**
 * Time kept at the very end for the code check, the exchange rates and sending the answer. These
 * take a few milliseconds. Saving happens after the answer is sent, so the Judge gets all the rest.
 */
export const FINISH_RESERVE_MS = 150;
export const NEIGHBOUR_MAX_AGE_MS = 180 * 24 * 3600 * 1000;
export const NEIGHBOUR_WAIT_MS = 600;
/**
 * The Judge is skipped only if less than this is left (after Eyes, Memory and search). The search
 * is shortened long before that happens: see `cfg.judgeTargetMs`.
 */
export const JUDGE_MIN_MS = 1500;
/** Below this there is no point in starting a search. */
export const SEARCH_MIN_MS = 400;
/** After the search, the Judge may wait this long for a Detail eye that is still working (and the same again for the Authenticity eye). This wait is taken out of the Judge's time: it happens before judgeMs is calculated. */
export const DETAIL_GRACE_MS = 250;
/** Memory is one quick database call. If it is slower than this, treat it as a miss. */
export const MEMORY_TIMEOUT_MS = 500;
