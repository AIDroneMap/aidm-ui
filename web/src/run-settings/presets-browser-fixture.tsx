import { createRoot } from "react-dom/client";
import { RunStart } from "../run-start/RunStart.tsx";
import "../styles.css";
createRoot(document.getElementById("root")!).render(<RunStart projectId={Number(new URLSearchParams(location.search).get("project"))} onAuthRequired={() => {}} />);
