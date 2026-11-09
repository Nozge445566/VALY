/**
 * Time kept at the very end for the code check, the exchange rates and sending the answer. These
 * take a few milliseconds. Saving happens after the answer is sent, so the Judge gets all the rest.
 */
export const FINISH_RESERVE_MS = 150;
/** Below this there is no point in starting a search. */
export const SEARCH_MIN_MS = 400;
/** After the search, the Judge may wait this long for a Detail eye that is still working (and the same again for the Authenticity eye). This wait is taken out of the Judge's time: it happens before judgeMs is calculated. */
export const DETAIL_GRACE_MS = 250;
/** Memory is one quick database call. If it is slower than this, treat it as a miss. */
export const MEMORY_TIMEOUT_MS = 500;
