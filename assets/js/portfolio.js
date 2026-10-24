import { HinaStage, ambientPaused, toggleAmbient } from './live2d-stage.js?v=avatar-loader-1';
import { TourFocus } from './tour-focus.js?v=inspection-layout-1';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : systemTheme.matches;
function themeLabel() {
  $('theme-toggle').setAttribute('aria-label', isDark() ? 'Ativar tema claro' : 'Ativar tema escuro');
  document.querySelector('meta[name="theme-color"]').content = isDark() ? '#20251f' : '#f5f2e9';
}
$('theme-toggle').addEventListener('click', () => {
  root.dataset.theme = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('rhayron-theme', root.dataset.theme); } catch {}
  themeLabel();
});
systemTheme.addEventListener('change', themeLabel);
themeLabel();

const chapters = await fetch('assets/data/tour.json?v=inspection-layout-1').then(response => {
  if (!response.ok) throw new Error('Tour content unavailable');
  return response.json();
});
const panel = $('hina-guide');
const launcher = $('guide-launcher');
const focusTour = new TourFocus(panel, reduced);
const audioBuffers = new Map();
let audioContext, audioSource, analyser, audioFrame, audioAbort;
let selectedAvatar = "haru";
let index = 0;
let isOpen = false;
let voice = false;
let guideStage;
let speechVersion = 0;
let speechTimer;
let returnFocus = launcher;
let navigationTarget = null;
let navigationTimeout;
let scrollFrame;

// While narration plays, keep the guide in a compact bar and preserve the full avatar above it.
const speakingGuideStyles = document.createElement('style');
speakingGuideStyles.textContent = `
.hina-guide[data-guided="true"][data-speaking="true"] .guide-avatar{
  width:250px;height:min(37vh,335px);margin:0 15px -20px auto;
}
.hina-guide[data-guided="true"][data-speaking="true"] .guide-bubble{
  min-height:64px;max-height:none;overflow:visible;padding:11px 14px;
  border-radius:18px 18px 6px 18px;
}
.hina-guide[data-guided="true"][data-speaking="true"] .guide-top{margin:0}
.hina-guide[data-guided="true"][data-speaking="true"] .guide-kicker,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-topic,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-text,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-transcript,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-select,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-navigation,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-follow-controls,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-settings,
.hina-guide[data-guided="true"][data-speaking="true"] .guide-audio-note{display:none}
.hina-guide[data-guided="true"][data-speaking="true"] .guide-progress{left:14px;right:14px}
@media (max-width:700px){
  .hina-guide[data-guided="true"][data-speaking="true"] .guide-avatar{
    width:250px;height:min(37vh,335px);margin:0 8px -20px auto;
  }
}
`;
document.head.append(speakingGuideStyles);


// The same stage and motion engine as the Hina landing, with deferred GPU work.
const heroStage = new HinaStage($('hero-avatar'), $('hero-backend'));
heroStage.load('haru');

function voiceLabel() {
  panel.dataset.voiceEnabled = String(voice);
  focusTour.render();
  $('guide-voice').setAttribute('aria-pressed', String(voice));
  $('guide-voice').textContent = voice ? '◖ Silenciar voz' : '◖ Ouvir a Hina';
}
function stopSpeech() {
  speechVersion++;
  clearTimeout(speechTimer);
  audioAbort?.abort();
  cancelAnimationFrame(audioFrame);
  if (audioSource) {
    audioSource.onended = null;
    try { audioSource.stop(); } catch {}
    audioSource.disconnect();
    audioSource = null;
  }
  analyser?.disconnect();
  analyser = null;
  guideStage?.setSpeaking(false);
  guideStage?.setAudioLevel(0);
  panel.dataset.speaking = 'false';
  focusTour.clear();
}
async function narrate() {
  stopSpeech();
  if (!isOpen || !voice || document.hidden || !audioContext) return;
  const version = speechVersion;
  const id = chapters[index].id;
  audioAbort = new AbortController();
  try {
    let buffer = audioBuffers.get(id);
    if (!buffer) {
      const response = await fetch(`assets/audio/guide/${id}.mp3?v=inspection-layout-1`, {signal:audioAbort.signal});
      if (!response.ok) throw new Error('Narration unavailable');
      buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
      if (version !== speechVersion) return;
      audioBuffers.set(id, buffer);
    }
    await audioContext.resume();
    if (version !== speechVersion || !voice || !isOpen || document.hidden) return;
    audioSource = audioContext.createBufferSource();
    audioSource.buffer = buffer;
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioSource.connect(analyser);
    analyser.connect(audioContext.destination);
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = audioContext.currentTime;
    focusTour.start(id);
    guideStage?.setSpeaking(true);
    panel.dataset.speaking = 'true';
    panel.dataset.audioModel = 'eleven_v4_turbo';
    $('guide-audio-note').textContent = 'Voz da Hina · ElevenLabs v4 Turbo';
    const sample = () => {
      if (version !== speechVersion || !analyser) return;
      focusTour.update(audioContext.currentTime - startedAt, buffer.duration);
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      guideStage?.setAudioLevel(Math.sqrt(sum / samples.length));
      audioFrame = requestAnimationFrame(sample);
    };
    audioSource.onended = () => {
      if (version !== speechVersion) return;
      const advance = focusTour.enabled && voice && isOpen && !document.hidden && index < chapters.length - 1;
      stopSpeech();
      if (advance) {
        speechTimer = setTimeout(() => {
          if (!isOpen || !voice || document.hidden) return;
          if (!focusTour.enabled) { voice = false; voiceLabel(); return; }
          setChapter(index + 1);
        }, 700);
      } else {
        voice = false;
        voiceLabel();
        $('guide-audio-note').textContent = index === chapters.length - 1
          ? 'Passeio concluído. Explore à vontade.'
          : 'Fala concluída. Você escolhe a próxima parada.';
      }
    };
    audioSource.start();
    sample();
  } catch (error) {
    if (version !== speechVersion || error.name === 'AbortError') return;
    stopSpeech();
    voice = false;
    voiceLabel();
    $('guide-audio-note').textContent = 'O áudio não carregou. Toque em ouvir para tentar de novo.';
  }
}
function renderChapter({ speak = true } = {}) {
  const chapter = chapters[index];
  $('guide-step').textContent = `${chapter.label} · ${index + 1} / ${chapters.length}`;
  $('guide-topic').textContent = chapter.title;
  $('guide-text').textContent = chapter.text;
  $('guide-select').value = chapter.id;
  $('guide-prev').disabled = index === 0;
  $('guide-next').textContent = index === 0 ? 'Vamos começar ↗' : index === chapters.length - 1 ? 'Voltar ao início ↶' : 'Próxima parada →';
  panel.dataset.context = chapter.id;
  if (speak && voice) speechTimer = setTimeout(narrate, 450);
}
function setChapter(nextIndex, options) {
  if (nextIndex === index) return;
  stopSpeech();
  index = nextIndex;
  renderChapter(options);
}
function visibleChapter() {
  const y = innerHeight * .42;
  const found = chapters.findLastIndex(c => {
    const r = $(c.target).getBoundingClientRect();
    return r.top <= y && r.bottom > y;
  });
  return found < 0 ? index : found;
}
function jump(nextIndex) {
  navigationTarget = nextIndex;
  clearTimeout(navigationTimeout);
  setChapter(nextIndex);
  if (!voice || !focusTour.enabled) {
    $(chapters[nextIndex].target).scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block:'start' });
  }
  // Keep intermediate rooms from interrupting narration during a long smooth scroll.
  navigationTimeout = setTimeout(() => { navigationTarget = null; }, 1800);
}
function openGuide(fromIntro = false) {
  if (isOpen) { if (fromIntro) jump(0); return; }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : launcher;
  isOpen = true;
  panel.hidden = false;
  launcher.hidden = true;
  launcher.setAttribute('aria-expanded', 'true');
  if (!guideStage) {
    guideStage = new HinaStage($('guide-avatar'), $('guide-backend'));
    guideStage.load(selectedAvatar);
  }
  guideStage.running = true;
  index = fromIntro ? 0 : visibleChapter();
  renderChapter();
  $('guide-close').focus({ preventScroll:true });
}
function closeGuide() {
  isOpen = false;
  stopSpeech();
  clearTimeout(navigationTimeout);
  navigationTarget = null;
  panel.hidden = true;
  launcher.hidden = false;
  launcher.setAttribute('aria-expanded','false');
  if (guideStage) guideStage.running = false;
  (returnFocus?.isConnected ? returnFocus : launcher).focus({ preventScroll:true });
}
launcher.addEventListener('click', () => openGuide());
document.querySelectorAll('[data-open-guide]').forEach(button => button.addEventListener('click', async () => {
  openGuide(true);
  await startGuideVoice();
}));
$('guide-close').addEventListener('click', closeGuide);
$('guide-prev').addEventListener('click', () => jump(Math.max(0, index - 1)));
$('guide-next').addEventListener('click', () => jump((index + 1) % chapters.length));
$('guide-select').addEventListener('change', e => jump(chapters.findIndex(c => c.id === e.target.value)));
$('guide-voice').addEventListener('click', async () => {
  if (voice) { voice = false; voiceLabel(); stopSpeech(); return; }
  await startGuideVoice();
});

async function startGuideVoice() {
  if (voice) return;
  voice = true;
  voiceLabel();
  try {
    audioContext ||= new AudioContext();
    await audioContext.resume();
    if (voice) narrate();
  } catch {
    voice = false;
    voiceLabel();
    $('guide-audio-note').textContent = 'Áudio indisponível neste navegador.';
  }
}

function motionLabel() {
  const paused = ambientPaused();
  $('guide-motion').setAttribute('aria-pressed', String(paused));
  $('guide-motion').textContent = paused ? 'Animar Hina' : 'Pausar Hina';
}
$('guide-motion').addEventListener('click', () => { toggleAmbient(); motionLabel(); });
$('guide-transcript').addEventListener('click', () => {
  const expanded = panel.dataset.transcript !== 'open';
  panel.dataset.transcript = expanded ? 'open' : 'closed';
  $('guide-transcript').setAttribute('aria-expanded', String(expanded));
  $('guide-transcript').textContent = expanded ? 'Ocultar fala' : 'Ver fala';
  focusTour.frameTarget();
});
reduced.addEventListener('change', motionLabel);
motionLabel();
document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) closeGuide(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
// Keep models intact for browsers restoring this page from their back/forward cache.
window.addEventListener('pagehide', () => {
  stopSpeech();
  heroStage.running = false;
  if (guideStage) guideStage.running = false;
});
window.addEventListener('pageshow', () => {
  heroStage.running = true;
  if (guideStage) guideStage.running = isOpen;
});
function onScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    const max = document.documentElement.scrollHeight - innerHeight;
    $('reading-progress').style.transform = `scaleX(${max > 0 ? Math.max(0, Math.min(1, scrollY / max)) : 0})`;
    if (isOpen && !voice && navigationTarget === null) setChapter(visibleChapter());
  });
}
addEventListener('scroll', onScroll, { passive:true });
addEventListener('resize', () => {
  navigationTarget = null;
  clearTimeout(navigationTimeout);
  onScroll();
  focusTour.frameTarget();
}, { passive:true });
addEventListener('scrollend', () => { navigationTarget = null; clearTimeout(navigationTimeout); });
onScroll();

// The montage renders the original sample models, with the same engine as the guide.
const montageStages = new Map();
const montageObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    montageObserver.unobserve(entry.target);
    const id = entry.target.dataset.model;
    const stage = new HinaStage(entry.target, $(`montage-status-${id}`));
    montageStages.set(id, stage);
    stage.load(id);
  });
}, {rootMargin:'150px'});
document.querySelectorAll('[data-model]').forEach(host => montageObserver.observe(host));
document.querySelectorAll('[data-avatar-choice]').forEach(button => {
  button.addEventListener('click', () => {
    const id = button.dataset.avatarChoice;
    selectedAvatar = id;
    document.querySelectorAll('[data-avatar-choice]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    montageStages.get(id)?.react();
    if (guideStage && guideStage.status.dataset.model !== id) guideStage.load(id);
    const keepNarration = isOpen && voice && focusTour.enabled;
    if (!isOpen) openGuide();
    if (!keepNarration) setChapter(chapters.findIndex(chapter => chapter.id === 'presenca'));
  });
});

// A didactic overlay, independent from any inference service.
const inspectionToggle = $('inspection-toggle');
inspectionToggle.addEventListener('click', () => {
  const shown = inspectionToggle.getAttribute('aria-pressed') !== 'true';
  inspectionToggle.setAttribute('aria-pressed', String(shown));
  $('inspection-visual').dataset.overlay = String(shown);
  inspectionToggle.textContent = shown ? 'Ocultar simulação ↙' : 'Mostrar simulação ↗';
});

const inspectionVisual = $('inspection-visual');
new IntersectionObserver(([entry]) => {
  inspectionVisual.dataset.scanning = String(entry.isIntersecting);
}, {threshold:.2}).observe(inspectionVisual);
