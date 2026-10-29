import { createRoot } from "react-dom/client";
import { PhotoFacts } from "./PhotoFacts.tsx";

let refresh = 0;
const root = createRoot(document.getElementById("root")!);
Object.assign(window, {
  showFacts: (projectId: number) => root.render(<PhotoFacts key={projectId} projectId={projectId} refresh={0} onAuthRequired={() => { document.body.dataset.auth = "required"; }} />),
  refreshFacts: () => root.render(<PhotoFacts key={1} projectId={1} refresh={++refresh} onAuthRequired={() => { document.body.dataset.auth = "required"; }} />),
  hideFacts: () => root.render(null),
});
(window as unknown as { showFacts(id: number): void }).showFacts(1);
