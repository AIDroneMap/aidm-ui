import { createRoot } from "react-dom/client";
import { RunStart } from "./RunStart.tsx";

createRoot(document.getElementById("root")!).render(<RunStart projectId={1} onAuthRequired={() => {}} />);
