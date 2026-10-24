// Cues follow the playback clock, so buffering never runs ahead of the voice.
const cues = {
  intro: [[0, '#topo .hero-copy', 'Boas-vindas'], [.7, '#projetos .index-heading', 'Os projetos']],
  onda: [[0, '#onda .signal-study', 'Enxergar com som'], [.42, '#tour-acoustic', 'Ultrassom na GPU'], [.65, '#tour-pose', 'A posição da sonda']],
  olho: [[0, '#ficha .head', 'Visão na indústria'], [.25, '#inspection-examples', 'Exemplo de inspeção'], [.57, '#cmp', 'Contêiner · câmera e segmentação']],
  splat: [[0, '#splat-project .splat-story-head', 'Das imagens ao espaço'], [.24, '#splat-pipeline', 'Como a cena é reconstruída'], [.6, '#splat-view', 'Gaussian Splatting ao vivo'], [.84, '#splat-views-gallery', 'A mesma cena, outros ângulos']],
  presenca: [[0, '#avatar-montage', 'Avatares Live2D'], [.72, '.dashboard-showcase', 'Dashboard da Hina']],
  oficio: [[0, '#oficio .room-head', 'Coado · plano de estudos'], [.35, '#tour-coado', 'Computador, celular e relógio']],
  genstock: [[0, '#tour-genstock', 'GenStock Studio'], [.65, '#tour-applypilot', 'ApplyPilot']],
  arquivo: [[0, '#arquivo .room-head', 'As raízes dos projetos'], [.38, '#tour-archive-yolo', 'Cadernos de visão computacional']],
  sobre: [[0, '#sobre .sobre h2', 'Sobre o Rhayron'], [.43, '#sobre .contact', 'Vamos conversar']],
};

export class TourFocus {
  constructor(panel, reduced) {
    this.panel = panel;
    this.reduced = reduced;
    this.button = document.getElementById('guide-follow');
    this.note = document.getElementById('guide-focus-note');
    this.comparator = document.getElementById('cmp');
    this.range = document.getElementById('cmp-range');
    this.enabled = true;
    this.active = false;
    this.button.addEventListener('click', () => {
      this.enabled = !this.enabled;
      if (!this.enabled) this.clear({restore:false, preserveChapter:true});
      else this.active = Boolean(this.chapter);
      this.render();
    });
    // Only direct user input relinquishes control, never our own scroll events.
    const release = event => {
      if (event.target?.closest?.('#cmp, #avatar-montage, [data-avatar-choice]')) return;
      if ((this.active || (this.enabled && panel.dataset.voiceEnabled === 'true')) && !panel.contains(event.target)) this.interrupt();
    };
    window.addEventListener('wheel', release, {passive:true});
    window.addEventListener('touchmove', release, {passive:true});
    document.addEventListener('pointerdown', event => {
      if (event.target.closest('#cmp, #avatar-montage, [data-avatar-choice]')) return;
      if (event.target.closest('main a, main button, .rail a, #splat-view') || event.clientX >= document.documentElement.clientWidth) release(event);
    }, {passive:true});
    document.addEventListener('keydown', event => {
      if (['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key)) release(event);
    });
    // The comparator is part of this chapter: explore it without giving up the guided tour.
    this.range.addEventListener('input', () => {});
    this.render();
  }

  render() {
    this.button.setAttribute('aria-pressed', String(this.enabled));
    this.button.textContent = this.enabled ? 'Foco automático · ligado' : 'Retomar foco automático';
    this.panel.dataset.following = String(this.active && this.enabled);
    const guided = this.enabled && this.panel.dataset.voiceEnabled === 'true';
    this.panel.dataset.guided = String(guided);
    if (!guided) delete this.panel.dataset.side;
    if (!this.enabled) this.note.textContent = 'Você conduz. Retome o foco quando quiser.';
    else if (!this.active) this.note.textContent = 'Ao ouvir, Hina conduz a página e avança sozinha.';
  }

  start(chapter) {
    this.clear();
    this.chapter = chapter;
    this.active = this.enabled;
    this.render();
  }

  update(elapsed, duration) {
    this.panel.style.setProperty('--tour-progress', String(Math.min(1, elapsed / duration)));
    if (!this.active || !this.enabled) return;
    const progress = elapsed / duration;
    const list = cues[this.chapter] || [];
    const cue = list.findLast(item => progress >= item[0]);
    if (cue && cue !== this.cue) {
      this.unhighlight();
      this.cue = cue;
      this.target = document.querySelector(cue[1]);
      if (!this.target) return;
      this.target.classList.add('tour-focus');
      this.panel.dataset.focusTarget = cue[1];
      this.note.textContent = `Agora · ${cue[2]}`;
      this.frameTarget();
      if (cue[1] === '#cmp') {
        this.comparisonStart = elapsed;
        this.originalComparison = this.range.value;
        this.comparator.dataset.touring = 'true';
      }
    }
    if (this.cue?.[1] === '#cmp') {
      const phase = (elapsed - this.comparisonStart) / 4.5;
      // Reduced motion gets a quiet before/after change instead of a sweeping wipe.
      const value = this.reduced.matches
        ? [0, 100, 50][Math.min(2, Math.floor(phase * 2))]
        : 50 - 50 * Math.sin(phase * Math.PI * 2);
      this.range.value = String(Math.round(value));
      this.range.dispatchEvent(new Event('input', {bubbles:true}));
    }
  }

  frameTarget() {
    if (!this.target || !this.active) return;
    const rect = this.target.getBoundingClientRect();
    const mobile = window.innerWidth <= 700;
    const rightHandTarget = rect.left > window.innerWidth * .38;
    this.panel.dataset.side = !mobile && rightHandTarget ? 'left' : 'right';
    const top = document.querySelector('.rail').getBoundingClientRect().bottom + 24;
    const bottom = mobile ? this.panel.getBoundingClientRect().top - 16 : window.innerHeight - 30;
    const available = Math.max(100, bottom - top);
    const inset = rect.height < available ? (available - rect.height) / 2 : 0;
    this.smoothScrollTo(Math.max(0, window.scrollY + rect.top - top - inset));
  }

  smoothScrollTo(top) {
    if (this.reduced.matches) { window.scrollTo({top, behavior:'instant'}); return; }
    cancelAnimationFrame(this.scrollFrame);
    const start = window.scrollY;
    const distance = top - start;
    const duration = Math.min(1050, Math.max(460, Math.abs(distance) * .45));
    const beganAt = performance.now();
    const tick = now => {
      const progress = Math.min(1, (now - beganAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      window.scrollTo({top:start + distance * eased, behavior:'instant'});
      if (progress < 1 && this.active && this.enabled) this.scrollFrame = requestAnimationFrame(tick);
    };
    this.scrollFrame = requestAnimationFrame(tick);
  }

  unhighlight(restore = true) {
    this.target?.classList.remove('tour-focus');
    if (this.originalComparison !== undefined) {
      if (restore) {
        this.range.value = this.originalComparison;
        this.range.dispatchEvent(new Event('input', {bubbles:true}));
      }
      this.originalComparison = undefined;
    }
    delete this.comparator.dataset.touring;
    this.target = null;
    this.cue = null;
  }

  clear({restore = true, preserveChapter = false} = {}) {
    this.unhighlight(restore);
    this.active = false;
    if (!preserveChapter) this.chapter = null;
    delete this.panel.dataset.focusTarget;
    this.panel.style.setProperty('--tour-progress', '0');
    this.render();
  }

  interrupt() {
    this.enabled = false;
    // Cancel an in-flight smooth scroll when the reader takes over.
    cancelAnimationFrame(this.scrollFrame);
    window.scrollTo({top:window.scrollY, behavior:'instant'});
    this.clear({restore:false, preserveChapter:true});
  }
}
