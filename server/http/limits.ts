import { SAMPLE_DATASET } from "../sample/sample-dataset.ts";

/** Every request this server reads is small JSON. A route that takes more says so with withBodyLimit. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/**
 * The most any route may take: the sample dataset's zip, which the operator
 * can import, with a margin. This is the ceiling Bun enforces for the whole
 * server. The guard holds every other route to MAX_REQUEST_BODY_BYTES.
 */
export const MAX_RAISED_BODY_BYTES = SAMPLE_DATASET.size + 16 * 1024 ** 2;
