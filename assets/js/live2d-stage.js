/* GPL-3.0-or-later. Hina Cubism model + original Live2DMotionEngine, with native WebGPU drawing. */
import { CubismWebGPU } from "./cubism-webgpu.js";
export const avatars = {
  hiyori: { name: "Hiyori", path: "assets/models/hiyori/Hiyori.model3.json" },
  haru: { name: "Haru", path: "assets/models/haru/Haru.model3.json" },
  mao: { name: "Mao", path: "assets/models/mao/Mao.model3.json" },
  wanko: { name: "Wanko", path: "assets/models/wanko/Wanko.model3.json" },
};
const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
let motionChoice;
try {
  motionChoice = localStorage.getItem("hina-guide-motion");
} catch {}
export function ambientPaused() {
  return motionChoice === "pause" || (motionChoice !== "play" && systemMotion.matches);
}
export function toggleAmbient() {
  motionChoice = ambientPaused() ? "play" : "pause";
  try {
    localStorage.setItem("hina-guide-motion", motionChoice);
  } catch {}
  return ambientPaused();
}
let libraries;
let compatibilityApp;
function compatibilityRenderer() {
  // Cubism's WebGL shader cache expects one GL context. Share it across tiles.
  compatibilityApp ||= new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    autoStart: false,
    resolution: Math.min(devicePixelRatio || 1, 2),
    preserveDrawingBuffer: true,
  });
  return compatibilityApp;
}
// Hina serializes SDK model loading; preserve that contract across gallery + guide.
let modelLoads = Promise.resolve();
function loadModel(path) {
  const next = modelLoads.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let model;
      try {
        model = await PIXI.live2d.Live2DModel.from(path, {
          autoInteract: false,
          autoUpdate: false,
        });
        const internal = model.internalModel;
        if (
          (internal.settings.physics && !internal.physics) ||
          (internal.settings.pose && !internal.pose)
        )
          throw new Error("Model physics or pose did not load");
        return model;
      } catch (error) {
        model?.destroy({ children: true, texture: false, baseTexture: false });
        if (attempt) throw error;
      }
    }
  });
  modelLoads = next.catch(() => {});
  return next;
}
const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    const timeout = setTimeout(() => {
      s.remove();
      reject(new Error("Live2D runtime timed out"));
    }, 15000);
    s.onload = () => { clearTimeout(timeout); resolve(); };
    s.onerror = () => { clearTimeout(timeout); reject(new Error("Could not load Live2D runtime")); };
    document.head.append(s);
  });
async function loadLibraries() {
  if (!libraries)
    libraries = (async () => {
      await loadScript("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js");
      await loadScript("assets/vendor/pixi-7.4.3/pixi.min.js");
      await loadScript("assets/vendor/pixi-live2d-display-0.4.0/cubism4.min.js");
      await loadScript("assets/vendor/hina/live2d-motion.js");
      PIXI.live2d.config.sound = false;
      PIXI.live2d.SoundManager.volume = 0;
    })().catch((error) => {
      libraries = null;
      throw error;
    });
  return libraries;
}
export class HinaStage {
  constructor(host, status) {
    this.host = host;
    this.status = status;
    this.running = true;
    this.visible = true;
    this.abort = new AbortController();
    this.generation = 0;
    this.observer = new IntersectionObserver(
      ([entry]) => {
        this.visible = entry.isIntersecting;
      },
      { threshold: 0 }
    );
    this.observer.observe(host);
    this.reduced = {
      get matches() {
        return ambientPaused();
      },
    };
    const signal = this.abort.signal;
    window.addEventListener(
      "pointermove",
      (e) => {
        if (this.active() && !this.reduced.matches)
          this.engine?.lookAt(e.clientX, e.clientY, this.canvas);
      },
      { passive: true, signal }
    );
    host.addEventListener("pointerleave", () => this.engine?.lookAway(), { signal });
    this.tick = this.tick.bind(this);
    this.frame = requestAnimationFrame(this.tick);
  }
  active() {
    return this.running && this.visible && !document.hidden && this.model && this.renderer;
  }
  label(pt, en) {
    this.status.dataset.pt = pt;
    this.status.dataset.en = en;
    this.status.textContent = document.documentElement.dataset.lang === "en" ? en : pt;
  }
  showLoading() {
    this.loader ||= this.host.querySelector(".avatar-loader");
    if (!this.loader) {
      this.loader = document.createElement("span");
      this.loader.className = "avatar-loader";
      this.loader.setAttribute("role", "status");
      this.loader.setAttribute("aria-label", "Carregando avatar");
      const ring = document.createElement("span");
      ring.className = "avatar-loader-ring";
      ring.setAttribute("aria-hidden", "true");
      this.loader.append(ring);
    }
    this.host.dataset.avatarState = "loading";
    this.host.setAttribute("aria-busy", "true");
    this.host.replaceChildren(this.loader);
  }
  finishLoading(state = "ready") {
    this.host.dataset.avatarState = state;
    this.host.setAttribute("aria-busy", "false");
    this.loader?.remove();
  }
  showFallback() {
    const image = new Image();
    image.src = "assets/hina-cutout.png";
    image.alt = "";
    image.className = "avatar-offline";
    this.host.replaceChildren(image);
    this.finishLoading("unavailable");
  }
  load(id) {
    const generation = ++this.generation;
    this.loadChain = (this.loadChain || Promise.resolve()).then(() =>
      this.loadModel(id, generation)
    );
    return this.loadChain;
  }
  async loadModel(id, generation) {
    if (generation !== this.generation) return;
    this.label("Preparando o avatar…", "Preparing avatar…");
    this.status.dataset.backend = "loading";
    this.clearModel();
    this.showLoading();
    try {
      await loadLibraries();
      if (generation !== this.generation) return;
      const model = await loadModel(avatars[id].path);
      if (generation !== this.generation) {
        model.destroy({ children: true, texture: false, baseTexture: false });
        return;
      }
      this.model = model;
      this.elapsed = 0;
      this.engine = new window.Live2DMotionEngine(model, {
        lipSyncGain: 5.0,
        eyeTracking: true,
        idleAnimation: true,
        autoBlink: true,
        headMotionScale: 1,
        beatSync: true,
        beatSyncStrength: 1,
        idleFsm: true,
        petMode: false,
      });
      this.engine.setSpeaking(Boolean(this.speaking));
      this.canvas = document.createElement("canvas");
      this.canvas.setAttribute("aria-hidden", "true");
      this.host.append(this.canvas);
      let gpu;
      try {
        if (new URLSearchParams(location.search).get("renderer") === "webgl")
          throw new Error("Compatibility preview");
        gpu = await CubismWebGPU.create(this.canvas, model);
        model.internalModel.update(16, 16);
        await gpu.validate();
        if (generation !== this.generation) {
          gpu.destroy();
          return;
        }
        this.renderer = gpu;
        this.backend = "webgpu";
        this.label("WebGPU · motor Hina", "WebGPU · Hina engine");
      } catch (error) {
        gpu?.destroy();
        if (generation !== this.generation) return;
        console.info("[Hina guide] WebGPU fallback:", error.message);
        // A canvas cannot change context type, so create a fresh compatibility surface.
        this.canvas.remove();
        this.canvas = document.createElement("canvas");
        this.canvas.setAttribute("aria-hidden", "true");
        this.host.append(this.canvas);
        this.app = compatibilityRenderer();
        this.fallbackContext = this.canvas.getContext("2d");
        this.backend = "webgl";
        this.renderer = this.app;
        this.label("WebGL · modo compatível", "WebGL · compatibility mode");
        this.status.title =
          document.documentElement.dataset.lang === "en"
            ? "WebGPU is not available here. The same Hina animation engine runs in compatibility mode."
            : "WebGPU indisponível aqui. O mesmo motor de animação da Hina roda em modo compatível.";
      }
      this.status.dataset.backend = this.backend;
      this.status.dataset.model = id;
      this.status.dataset.physics = String(Boolean(model.internalModel.physics));
      this.status.dataset.pose = String(Boolean(model.internalModel.pose));
      this.last = 0;
      this.firstFrame = true;
    } catch (error) {
      if (generation !== this.generation) return;
      console.warn("[Hina guide]", error);
      this.clearModel();
      this.showFallback();
      this.label(
        "Avatar indisponível · o guia continua em texto",
        "Avatar unavailable · the text guide still works"
      );
      this.status.dataset.backend = "unavailable";
    }
  }
  tick(now) {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.active()) {
      this.last = now;
      return;
    }
    if (this.reduced.matches && !this.firstFrame && !this.speaking) return;
    if (now - this.last < 1000 / 30) return;
    const delta = Math.min(50, this.last ? now - this.last : 16);
    this.last = now;
    this.elapsed += delta;
    try {
      if (this.backend === "webgpu") {
        this.model.internalModel.update(delta, this.elapsed);
        this.renderer.render();
        if (this.firstFrame || this.renderer.frames % 30 === 0) {
          this.status.dataset.frames = this.renderer.frames;
          this.status.dataset.geometryChanges = this.renderer.geometryChanges;
          this.status.dataset.masks = this.renderer.masks.size;
        }
      } else {
        const { width, height } = this.host.getBoundingClientRect();
        const ratio = Math.min(devicePixelRatio || 1, 2);
        if (width !== this.w || height !== this.h) {
          this.w = width;
          this.h = height;
          this.canvas.width = Math.round(width * ratio);
          this.canvas.height = Math.round(height * ratio);
          const m = this.model.internalModel,
            scale = Math.min(width / m.width, height / m.height) * 0.97;
          this.model.scale.set(scale);
          this.model.position.set((width - m.width * scale) / 2, (height - m.height * scale) / 2);
        }
        if (this.app.screen.width !== width || this.app.screen.height !== height)
          this.app.renderer.resize(width, height);
        this.app.stage.removeChildren();
        this.app.stage.addChild(this.model);
        this.model.update(delta);
        this.app.render();
        this.fallbackContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.fallbackContext.drawImage(this.app.view, 0, 0, this.canvas.width, this.canvas.height);
      }
      // Keep the dashboard loader until an actual frame is drawn, including WebGL fallback.
      if (this.firstFrame) this.finishLoading();
      this.firstFrame = false;
    } catch (error) {
      console.warn("[Hina guide] Drawing stopped:", error);
      this.running = false;
      if (this.firstFrame) this.showFallback();
      this.label(
        "Animação pausada · recarregue para tentar de novo",
        "Animation paused · reload to retry"
      );
      this.status.dataset.backend = "unavailable";
    }
  }
  react() {
    if (!this.model || this.reduced.matches) return;
    this.engine.setEmotionPose("happy", 1800);
    const groups = Object.keys(this.model.internalModel.motionManager.definitions);
    const group = groups.find((g) => /tap/i.test(g));
    if (group) this.model.motion(group, window.resolveLive2DMotionIndex(group), 3);
  }
  setAudioLevel(value) {
    this.engine?.setAudioLevel(value);
    if (value > Number(this.status.dataset.audioPeak || 0))
      this.status.dataset.audioPeak = value.toFixed(4);
  }
  setSpeaking(value) {
    this.speaking = value;
    this.engine?.setSpeaking(value);
  }
  clearModel() {
    this.engine?.dispose();
    this.engine = null;
    if (this.backend === "webgpu") this.renderer?.destroy();
    // Destroy the model before the Pixi stage so ownership is unambiguous.
    this.model?.destroy({ children: true, texture: false, baseTexture: false });
    this.model = null;
    this.app = null;
    this.fallbackContext = null;
    this.renderer = null;
    this.w = 0;
    this.h = 0;
  }
  destroy() {
    ++this.generation;
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.observer.disconnect();
    this.clearModel();
  }
}
