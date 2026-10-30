import { createRoot } from "react-dom/client";
import { ModelPanel } from "../web/src/model/ModelPanel.tsx";

const runId = new URLSearchParams(location.search).get("runId") ?? "";
createRoot(document.getElementById("root")!).render(<ModelPanel runId={runId} size={1024} />);
