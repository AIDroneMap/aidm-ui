import { createRoot } from "react-dom/client";
import { LinkSource } from "./LinkSource.tsx";

createRoot(document.getElementById("root")!).render(<LinkSource projectId={1} onSource={() => {}} onAuthRequired={() => {}} />);
