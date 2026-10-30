import { createRoot } from "react-dom/client";
import { RunProgress } from "./RunProgress.tsx";
import type { RunView } from "../../../shared/api-types.ts";

const run: RunView = { id: 7, projectId: 1, engineId: 1, createdAt: "2026-10-26T10:00:00Z", preset: null, wayIn: null, state: "completed", step: null, download: null, upload: null, progress: null, engineMessage: null, problem: null, restarted: false, restartedAtLine: null, resultsAvailable: false, results: { state: "failed", archiveSize: null, outputs: [] }, engineName: null, engineLocal: false, sample: false, name: null };
createRoot(document.getElementById("root")!).render(<RunProgress run={run} stage={null} lines={[]} connectionLost={false} cancelling={false} failure={null} onCancel={() => {}} onAgain={() => {}} />);
