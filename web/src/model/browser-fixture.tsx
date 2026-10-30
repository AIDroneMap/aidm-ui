import { createRoot } from "react-dom/client";
import { ModelPanel } from "./ModelPanel.tsx";

createRoot(document.getElementById("root")!).render(<ModelPanel runId="7" size={1024} />);
