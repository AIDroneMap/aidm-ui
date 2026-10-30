import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { t } from "../i18n/translate.ts";

function validateGlb(data: ArrayBuffer) {
  const view = new DataView(data);
  if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) throw new Error("Invalid GLB");
  let offset = 12;
  let json: unknown;
  let chunks = 0;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) throw new Error("Invalid GLB chunk");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 || length > data.byteLength - offset) throw new Error("Invalid GLB chunk");
    if (chunks === 0) {
      if (type !== 0x4e4f534a) throw new Error("Missing GLB JSON");
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data, offset, length)));
    } else if (type === 0x4e4f534a) throw new Error("Duplicate GLB JSON");
    offset += length; chunks++;
  }
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "uri" && (typeof entry !== "string" || !entry.startsWith("data:"))) throw new Error("External GLB resource");
      inspect(entry);
    }
  };
  inspect(json);
}

function disposeObject(root: THREE.Object3D) {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Line) && !(object instanceof THREE.Points)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) { value.dispose(); if (value.image instanceof ImageBitmap) value.image.close(); }
      material.dispose();
    }
  });
}

export default function ModelView({ runId }: { runId: string; size: number }) {
  const container = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => {});
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const host = container.current!;
    const abort = new AbortController();
    let stopped = false;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let models: THREE.Object3D[] = [];
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let removeKeys = () => {};
    const cleanup = () => {
      abort.abort(); cancelAnimationFrame(frame); observer?.disconnect(); removeKeys(); controls?.dispose();
      for (const model of models) disposeObject(model);
      models = [];
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove(); renderer = undefined;
    };
    const load = async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/outputs/glb`, { signal: abort.signal });
        if (!response.ok) throw new Error("Model request failed");
        const data = await response.arrayBuffer();
        if (stopped) return;
        validateGlb(data);
        const manager = new THREE.LoadingManager();
        let resourceFailed = false;
        manager.onError = () => { resourceFailed = true; };
        manager.setURLModifier(url => { if (!url.startsWith("blob:") && !url.startsWith("data:")) throw new Error("External GLB resource"); return url; });
        const loaded = await new GLTFLoader(manager).parseAsync(data, "");
        if (stopped) { for (const scene of loaded.scenes) disposeObject(scene); return; }
        models = loaded.scenes;
        if (resourceFailed) throw new Error("Model texture failed");
        const model = loaded.scene;
        const box = new THREE.Box3().setFromObject(model);
        const dimensions = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const extent = Math.max(dimensions.x, dimensions.y, dimensions.z);
        if (!Number.isFinite(extent) || extent <= 0 || ![center.x, center.y, center.z, dimensions.x, dimensions.y, dimensions.z].every(Number.isFinite)) throw new Error("Invalid model bounds");
        renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        const canvas = renderer.domElement;
        canvas.tabIndex = 0; canvas.setAttribute("aria-label", t("model.canvas"));
        canvas.style.cssText = "display:block;width:100%;height:400px;touch-action:none;outline-offset:2px";
        host.appendChild(canvas);
        const scene = new THREE.Scene(); scene.background = new THREE.Color(0xdddddd); scene.add(model);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 2));
        const camera = new THREE.PerspectiveCamera(45, 1, extent / 10000, extent * 10000);
        controls = new OrbitControls(camera, canvas);
        const initialPosition = center.clone().add(new THREE.Vector3(extent * 1.5, extent, extent * 1.5));
        const resetView = () => { camera.position.copy(initialPosition); controls!.target.copy(center); controls!.update(); };
        reset.current = resetView; resetView();
        const resize = () => { if (!renderer) return; const width = Math.max(canvas.clientWidth, 1); const height = Math.max(canvas.clientHeight, 1); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
        observer = new ResizeObserver(resize); observer.observe(canvas); resize();
        const keyboard = (event: KeyboardEvent) => {
          if (!controls) return;
          const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
          if (!arrows.includes(event.key) && !["+", "=", "-", "_"].includes(event.key)) return;
          event.preventDefault();
          if (event.shiftKey && arrows.includes(event.key)) {
            const distance = camera.position.distanceTo(controls.target) * 0.05;
            const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
            const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
            const delta = right.multiplyScalar(event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0).add(up.multiplyScalar(event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0));
            camera.position.add(delta); controls.target.add(delta);
          } else if (arrows.includes(event.key)) {
            const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
            spherical.theta += event.key === "ArrowLeft" ? -0.1 : event.key === "ArrowRight" ? 0.1 : 0;
            spherical.phi = THREE.MathUtils.clamp(spherical.phi + (event.key === "ArrowUp" ? -0.1 : event.key === "ArrowDown" ? 0.1 : 0), 0.01, Math.PI - 0.01);
            camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
          } else camera.position.sub(controls.target).multiplyScalar(event.key === "+" || event.key === "=" ? 0.9 : 1.1).add(controls.target);
          controls.update();
        };
        canvas.addEventListener("keydown", keyboard); removeKeys = () => canvas.removeEventListener("keydown", keyboard);
        const draw = () => { if (stopped || !renderer) return; controls!.update(); renderer.render(scene, camera); frame = requestAnimationFrame(draw); };
        draw(); setState("ready");
      } catch {
        if (!stopped) { cleanup(); setState("error"); }
      }
    };
    void load();
    return () => { stopped = true; cleanup(); reset.current = () => {}; };
  }, [runId]);
  return <div>
    {state === "loading" && <p role="status">{t("model.loading")}</p>}
    {state === "error" && <p role="alert">{t("model.error")}</p>}
    <div ref={container} />
    {state === "ready" && <><p>{t("model.instructions")}</p><button type="button" onClick={() => reset.current()}>{t("model.reset")}</button></>}
  </div>;
}
