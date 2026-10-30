import { createRoot } from "react-dom/client";
import { BasemapSettings } from "./BasemapSettings.tsx";
import { MapPanel } from "../map/MapView.tsx";

createRoot(document.getElementById("root")!).render(<><BasemapSettings onAuthRequired={() => {}} /><MapPanel runId="7" /></>);
