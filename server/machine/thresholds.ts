// The numbers the machine check, the downloads and the sample job decide by,
// in one place, so that the first benchmarks can change them in one edit.

const GiB = 1024 ** 3;

/** Below this much RAM the wizard refuses a local engine. */
export const RAM_REFUSE_BELOW = 8 * GiB;

/** Below this much RAM a local engine installs with a warning that normal datasets need a remote engine. */
export const RAM_WARN_BELOW = 16 * GiB;

/** Free disk a run needs, checked right before it starts. */
export const RUN_FREE_DISK = 10 * GiB;

/**
 * A download or a pull needs its size plus this share of it free, checked
 * right before it starts.
 */
export const DOWNLOAD_FREE_DISK_MARGIN = 0.2;

/**
 * A download fails only when no byte has arrived for this long. Until then it
 * tries again as often as it takes, each time from the last byte on disk.
 * Five minutes rides out a link that drops for a minute or two, as a mobile
 * link through a VPN does, and still tells a dead link within a coffee break.
 */
export const DOWNLOAD_STALL_MS = 5 * 60_000;

/**
 * A connection that stays open but sends nothing for this long is dropped and
 * made again, because a fresh connection often works where a silent one never
 * wakes up. Shorter than the stall time, so a download gets several new
 * connections before it gives up.
 */
export const DOWNLOAD_IDLE_MS = 60_000;

/**
 * How much room an image takes in a runtime's storage once its layers are
 * unpacked, as a multiple of its download size. Measured on 26 October 2026
 * by unpacking every layer of the three images of aidm-api 2.5.0: linux/arm64
 * 1,726,758,400 bytes from 622,710,197 (2.77 times), linux/amd64
 * 1,868,324,352 from 682,533,845 (2.74), and the graphics card image
 * 10,624,373,760 from 5,678,958,647 (1.87). The largest, rounded up.
 */
export const IMAGE_UNPACKED_FACTOR = 2.8;

/** The local engine keeps back at least this much memory for the computer itself. */
export const MEMORY_RESERVE_MIN = 2 * GiB;

/** Or this share of the total, whichever is larger. */
export const MEMORY_RESERVE_SHARE = 0.2;

/** The least memory the operator may give the local engine. */
export const MEMORY_CAP_MIN = 1 * GiB;

/**
 * The sample job's measured peak memory, in bytes. The sample job is offered
 * only on an engine whose memory cap is above it.
 *
 * Measured on 26 October 2026: the published ghcr.io/aidronemap/aidm-api:2.5.0
 * image (index digest sha256:d31ddbb2c1e04cfa67365c7a8dc9bc3b6b4f3b486371a2d60b97a2457c79bdcc)
 * ran the sample dataset (aidm-vineyard-small v1, commit
 * 6af198c9a327e187e088ede6d7c632eb77b50eaa) through the task API with the
 * engine's CI options: dsm on and max-concurrency 4. The container was pinned
 * to four CPUs and had no memory limit. The machine: AMD Ryzen 9 9900X
 * (12 cores, 24 threads), 60 GiB of RAM, Ubuntu 24.04, Docker 29.
 *
 * The value is the container cgroup's memory.peak, the larger of two runs:
 * 7,222,665,216 and 7,360,806,912 bytes. memory.peak includes page cache.
 * That is deliberate and on the safe side: page cache counts against the
 * container's memory limit, so the bar leaves room for it. For reference, in
 * the second run the anonymous memory, sampled every second, peaked at
 * 6,247,743,488 bytes (6.25 GB).
 */
export const SAMPLE_JOB_PEAK_MEMORY = 7_360_806_912;
