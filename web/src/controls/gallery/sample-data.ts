import {
  IconArrowLeft,
  IconBox,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconClipboardCheck,
  IconClock,
  IconCopy,
  IconCpu,
  IconDownload,
  IconEllipsis,
  IconFolder,
  IconFolderOpen,
  IconImage,
  IconImages,
  IconInfo,
  IconLayers,
  IconLink,
  IconLoaderCircle,
  IconLock,
  IconMap,
  IconMenu,
  IconPause,
  IconPlay,
  IconPlus,
  IconRefreshCw,
  IconRotateCcw,
  IconSave,
  IconSearch,
  IconSettings,
  IconSlidersHorizontal,
  IconTrash2,
  IconTriangleAlert,
  IconUpload,
  IconX,
} from "../../icons/icons.tsx";

export const ICONS = [
  ["IconArrowLeft", IconArrowLeft],
  ["IconBox", IconBox],
  ["IconCheck", IconCheck],
  ["IconChevronDown", IconChevronDown],
  ["IconChevronRight", IconChevronRight],
  ["IconCircle", IconCircle],
  ["IconCircleCheck", IconCircleCheck],
  ["IconCircleDashed", IconCircleDashed],
  ["IconCircleX", IconCircleX],
  ["IconClipboardCheck", IconClipboardCheck],
  ["IconClock", IconClock],
  ["IconCopy", IconCopy],
  ["IconCpu", IconCpu],
  ["IconDownload", IconDownload],
  ["IconEllipsis", IconEllipsis],
  ["IconFolder", IconFolder],
  ["IconFolderOpen", IconFolderOpen],
  ["IconImage", IconImage],
  ["IconImages", IconImages],
  ["IconInfo", IconInfo],
  ["IconLayers", IconLayers],
  ["IconLink", IconLink],
  ["IconLoaderCircle", IconLoaderCircle],
  ["IconLock", IconLock],
  ["IconMap", IconMap],
  ["IconMenu", IconMenu],
  ["IconPause", IconPause],
  ["IconPlay", IconPlay],
  ["IconPlus", IconPlus],
  ["IconRefreshCw", IconRefreshCw],
  ["IconRotateCcw", IconRotateCcw],
  ["IconSave", IconSave],
  ["IconSearch", IconSearch],
  ["IconSettings", IconSettings],
  ["IconSlidersHorizontal", IconSlidersHorizontal],
  ["IconTrash2", IconTrash2],
  ["IconTriangleAlert", IconTriangleAlert],
  ["IconUpload", IconUpload],
  ["IconX", IconX],
] as const;

/* Sample data for the gallery. In the product these come from the engine and the project, so they are data and not interface text. */

export const PROJECT_NAME = "Vineyard north slope";
export const CAMERA = "FC6310";
export const PHOTO_COUNT = 312;
export const PHOTO_COUNT_SECOND_FLIGHT = 48;
export const ACTIVE_RUN_ID = "run-0007";

export const FILE_NAMES = [
  "DJI_0001.JPG",
  "DJI_0002.JPG",
  "DJI_0003.JPG",
  "DJI_0004.JPG",
  "DJI_0005.JPG",
  "DJI_0006.JPG",
  "DJI_0107.JPG",
  "DJI_0108.JPG",
] as const;

export const FILE_ROWS = [
  { name: "DJI_0001.JPG", size: "8.4 MB", taken: "2026-09-14 10:02:11" },
  { name: "DJI_0002.JPG", size: "8.6 MB", taken: "2026-09-14 10:02:19" },
  { name: "DJI_0003.JPG", size: "8.3 MB", taken: "2026-09-14 10:02:27" },
] as const;

export const FACTS = {
  camera: CAMERA,
  photos: String(PHOTO_COUNT),
  taken: "2026-09-14",
  height: "90 m",
  size: "2.6 GB",
} as const;

/** The size that the delete question names. */
export const DELETE_SIZE = "4.2 GB";

export const SEARCH_FILES = ["DJI_0001.JPG", "DJI_0002.JPG", "DJI_0003.JPG", "DJI_0107.JPG", "DJI_0108.JPG", "IMG_2041.JPG"] as const;

export const RUN_TIME = "10:42";

export const DIFF_ROWS = [
  { id: "feature_quality", code: "--feature-quality", from: "high", to: "ultra" },
  { id: "orthophoto_resolution", code: "--orthophoto-resolution", from: "5", to: "2" },
  { id: "pc_quality", code: "--pc-quality", from: "medium", to: "high" },
] as const;

const FLIGHT_ONE = { start: Date.UTC(2026, 8, 14, 10, 2), end: Date.UTC(2026, 8, 14, 10, 51), first: "10:02", last: "10:51", day: "2026-09-14" };
const FLIGHT_TWO = { start: Date.UTC(2026, 8, 14, 15, 18), end: Date.UTC(2026, 8, 14, 15, 33), first: "15:18", last: "15:33", day: "2026-09-14" };
export const FLIGHTS = [
  { id: "1", ...FLIGHT_ONE, count: PHOTO_COUNT },
  { id: "2", ...FLIGHT_TWO, count: PHOTO_COUNT_SECOND_FLIGHT },
] as const;
export const TIMELINE_START = FLIGHT_ONE.start - 30 * 60 * 1000;
export const TIMELINE_END = FLIGHT_TWO.end + 30 * 60 * 1000;

/** A small plain picture, as a data address, so the gallery loads nothing from anywhere. */
function swatch(fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="${fill}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const THUMBNAILS = [
  { id: "DJI_0001.JPG", src: swatch("#6b8f5e") },
  { id: "DJI_0002.JPG", src: swatch("#8a9a6b") },
  { id: "DJI_0003.JPG", src: null },
  { id: "DJI_0004.JPG", src: swatch("#a7a07a") },
  { id: "DJI_0005.JPG", src: null },
  { id: "DJI_0006.JPG", src: swatch("#7a8c8f") },
] as const;
