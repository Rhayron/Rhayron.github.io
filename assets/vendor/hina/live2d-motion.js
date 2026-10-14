/**
 * Live2DMotionEngine — fluidez orgânica inspirada no projeto Airi (moeru-ai/airi).
 *
 * Porta, para JS puro (PIXI + pixi-live2d-display, bundle Cubism 4), as técnicas
 * que dão "vida" ao avatar da Airi:
 *
 *   1. Saccades de olhar + foco de cabeça em idle  (animation.ts / eye-motions.ts)
 *   2. Rastreio do cursor (cabeça e olhos seguem o mouse)
 *   3. Lip sync suave com física de mola + cauda de release (motion-manager.ts)
 *   4. Ênfase de cabeça durante a fala + beat-sync explícito para áudio/música
 *
 * O mecanismo central é o mesmo da Airi: sobrescrevemos `motionManager.update`
 * com fases pre -> update original do SDK -> post -> final. Assim o SDK segue
 * dono das motions/fades, enquanto expressão, blink e lip sync entram como
 * camadas finais previsíveis.
 *
 * Os modelos usam convenções de parâmetro diferentes (mao_pro: `ParamAngleX`,
 * boca `ParamA`; shizuku: legado `PARAM_ANGLE_X`, boca `PARAM_MOUTH_OPEN_Y`),
 * então resolvemos cada ID por modelo na inicialização.
 */
(function (global) {
  "use strict";

  // Instrumentação idle (console + snapshot + POST /debug/idle-log): OFF por default.
  // Ligar: window.__HINA_IDLE_DEBUG = true e recarregar.
  function idleDebugOn() {
    try { return global.__HINA_IDLE_DEBUG === true; } catch (_) { return false; }
  }

  // Fade injetado em runtime (assets Hiyori vêm com FadeOut=0). Camada B do estudo
  // de flip: suaviza entrada/saída de gestos explícitos (poke, [motion:…]).
  const GESTURE_FADE_IN_S = 0.45;
  const GESTURE_FADE_OUT_S = 0.55;
  const IDLE_CROSSFADE_S = 1.0;

  // Grupos com várias motions: índice 0 = variante mais suave (ex.: Tap m07 vs m08).
  const GENTLE_MOTION_INDEX = {
    Tap: 0,
    "Tap@Body": 0,
    Flick: 0,
    FlickUp: 0,
    FlickDown: 0,
    "Flick@Body": 0,
  };

  /** Índice de motion: explícito > mapa suave > undefined (SDK sorteia). */
  function resolveLive2DMotionIndex(group, explicitIndex) {
    if (Number.isInteger(explicitIndex)) return explicitIndex;
    if (group && Object.prototype.hasOwnProperty.call(GENTLE_MOTION_INDEX, group)) {
      return GENTLE_MOTION_INDEX[group];
    }
    return undefined;
  }
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const randFloat = (min, max) => min + Math.random() * (max - min);
  // smoothstep: 3t² - 2t³ (entra/sai com derivada zero nos extremos)
  const smoothstep = (t) => t * t * (3 - 2 * t);

  // ----------------------------------------------------------------
  // Distribuição de intervalos de saccade — porta de utils/eye-motions.ts.
  // Concentra movimentos rápidos curtos e ocasionalmente longos, imitando
  // o padrão real de micro-movimentos do olhar humano.
  // ----------------------------------------------------------------
  const SACCADE_STEP = 400;
  const SACCADE_DIST = [
    [0.075, 800],
    [0.110, 0],
    [0.125, 0],
    [0.140, 0],
    [0.125, 0],
    [0.050, 0],
    [0.040, 0],
    [0.030, 0],
    [0.020, 0],
    [1.000, 0],
  ];
  for (let i = 1; i < SACCADE_DIST.length; i++) {
    SACCADE_DIST[i][0] += SACCADE_DIST[i - 1][0];
    SACCADE_DIST[i][1] = SACCADE_DIST[i - 1][1] + SACCADE_STEP;
  }
  function randomSaccadeInterval() {
    const r = Math.random();
    for (let i = 0; i < SACCADE_DIST.length; i++) {
      if (r <= SACCADE_DIST[i][0]) {
        return SACCADE_DIST[i][1] + Math.random() * SACCADE_STEP;
      }
    }
    return SACCADE_DIST[SACCADE_DIST.length - 1][1] + Math.random() * SACCADE_STEP;
  }

  // ----------------------------------------------------------------
  // Candidatos de parâmetro por nome lógico. O primeiro que existir no
  // modelo vence (Cubism 4 moderno vs. legado UPPER_SNAKE).
  // ----------------------------------------------------------------
  const PARAM_CANDIDATES = {
    angleX: ["ParamAngleX", "PARAM_ANGLE_X"],
    angleY: ["ParamAngleY", "PARAM_ANGLE_Y"],
    angleZ: ["ParamAngleZ", "PARAM_ANGLE_Z"],
    eyeBallX: ["ParamEyeBallX", "PARAM_EYE_BALL_X"],
    eyeBallY: ["ParamEyeBallY", "PARAM_EYE_BALL_Y"],
    bodyAngleX: ["ParamBodyAngleX", "PARAM_BODY_X"],
    bodyAngleZ: ["ParamBodyAngleZ", "PARAM_BODY_Z"],
    eyeLOpen: ["ParamEyeLOpen", "PARAM_EYE_L_OPEN"],
    eyeROpen: ["ParamEyeROpen", "PARAM_EYE_R_OPEN"],
    // Boca: ParamMouthOpenY (padrão), legado, ou ParamA (mao_pro usa vogais).
    mouth: ["ParamMouthOpenY", "PARAM_MOUTH_OPEN_Y", "ParamA"],
    // Parâmetros faciais para poses emocionais suaves (modelos sem exp3).
    mouthForm: ["ParamMouthForm", "PARAM_MOUTH_FORM"],
    browLForm: ["ParamBrowLForm", "ParamBrowLY", "PARAM_BROW_L_Y"],
    browRForm: ["ParamBrowRForm", "ParamBrowRY", "PARAM_BROW_R_Y"],
    eyeLSmile: ["ParamEyeLSmile"],
    eyeRSmile: ["ParamEyeRSmile"],
    cheek: ["ParamCheek", "PARAM_CHEEK"],
  };

  // Poses emocionais suaves: alvos de parâmetro por emoção, aplicados com
  // ease-in → hold → ease-out por frame (estilo Airi). Para modelos só-de-motion
  // (Hiyori) que não têm expressões exp3 para segurar a emoção no rosto.
  // headZ/bodyZ são aditivos em graus (ParamAngleZ/ParamBodyAngleZ); o resto é
  // valor absoluto -1..1 dos respectivos parâmetros faciais.
  // `tau` = constante de tempo do blend (s), por emoção — como os blendDuration
  // da Airi (expression.ts): surpresa estala, tristeza desliza, neutro relaxa
  // devagar. tau ≈ blendDuration/3 (assenta em ~3·tau).
  const EMOTION_POSES = {
    happy:     { tau: 0.10, mouthForm: 1.0, eyeLSmile: 1.0, eyeRSmile: 1.0, cheek: 0.4, headZ: 4, bodyZ: 3 },
    sad:       { tau: 0.20, mouthForm: -0.8, browLForm: -0.6, browRForm: -0.6, headZ: -5, bodyZ: -3 },
    angry:     { tau: 0.10, mouthForm: -0.6, browLForm: 1.0, browRForm: 1.0, cheek: 0.2, headZ: 0, bodyZ: 0 },
    surprised: { tau: 0.05, mouthForm: 0.2, browLForm: 0.8, browRForm: 0.8, cheek: 0.2, headZ: 0, bodyZ: 0 },
    // alternate: o tilt de cabeça troca de lado a cada ATIVAÇÃO FRESCA (o
    // dedup em setEmotionPose segura re-asserts da mesma emoção no hold —
    // think dispara 2× por turno: pré-evento do humor + marker [think]).
    // Amplitudes contidas e tau lento: a airi nem inclina cabeça por emoção;
    // aqui é um aceno sutil, não uma guinada.
    think:     { tau: 0.25, alternate: true, mouthForm: -0.2, browLForm: 0.3, browRForm: 0.1, headZ: 4, bodyZ: 1 },
    curious:   { tau: 0.25, alternate: true, mouthForm: 0.4, eyeLSmile: 0.3, eyeRSmile: 0.3, browLForm: 0.4, browRForm: 0.4, headZ: 3, bodyZ: 1.5 },
    question:  { tau: 0.25, alternate: true, mouthForm: 0.1, browLForm: 0.7, browRForm: 0.2, headZ: -3.5, bodyZ: -1 },
    awkward:   { tau: 0.15, mouthForm: -0.3, eyeLSmile: 0.3, eyeRSmile: 0.3, cheek: 0.5, headZ: 5, bodyZ: 0 },
    neutral:   {},
  };
  // Relaxamento para o neutro (fim do hold ou pose solta) — lento de propósito.
  const POSE_RELAX_TAU = 0.25;

  // Amplitudes do balanço de beat (graus, em amp=1 com slider 1). Calibradas
  // pelas CURVAS DE IDLE da própria Hiyori (hiyori_m01..m10: AngleZ ±13-30°,
  // AngleX ±8-23°, corpo ±5-10°, Z-dominante) — o beat é o MESMO tipo de
  // balanço do idle, só que mais acentuado, contínuo e no tempo da música.
  const BEAT_SWAY_X = 9;        // ParamAngleX (giro)
  const BEAT_SWAY_Z = 13;       // ParamAngleZ (tilt — dominante, como no idle)
  const BEAT_SWAY_BODY_X = 4;   // corpo acompanha menor e defasado
  const BEAT_SWAY_BODY_Z = 6;
  const BEAT_PHASE_LAG_Z = 0.6;    // defasagem do tilt vs giro (organicidade)
  const BEAT_PHASE_LAG_BODY = 1.0; // corpo atrasa atrás da cabeça
  const POSE_FACE_KEYS = ["mouthForm", "browLForm", "browRForm", "eyeLSmile", "eyeRSmile", "cheek"];
  const POSE_ADD_KEYS = ["headZ", "bodyZ"];
  // Idle: motor (blink/foco/pose) dono dos olhos — curvas do asset conflitam (Airi strip).
  const IDLE_MOTION_EYE_STRIP = new Set([
    "ParamEyeBallX", "ParamEyeBallY",
    "ParamEyeLOpen", "ParamEyeROpen",
    "ParamEyeLSmile", "ParamEyeRSmile",
  ]);

  // Parâmetros que mais "flippam" durante gestos do Hiyori (Tap/Flick/...): a
  // cabeça (ParamAngleZ gira ~39° em 0.14s) e braços (0→−10 num quadro). Sem
  // suavização, a transição idle→gesto entra/sai no tranco. Cada item é uma
  // lista de candidatos (Cubism 4 moderno vs. legado UPPER_SNAKE); o 1º que
  // existir no modelo é suavizado, os demais são ignorados.
  // ParamAngleX/Y ficam de fora de propósito — o foco/olhar é dono deles.
  const SMOOTH_PARAM_CANDIDATES = [
    ["ParamAngleZ", "PARAM_ANGLE_Z"],
    ["ParamBodyAngleX", "PARAM_BODY_X"],
    ["ParamBodyAngleY", "PARAM_BODY_Y"],
    ["ParamBodyAngleZ", "PARAM_BODY_Z"],
    ["ParamArmLA"],
    ["ParamArmRA"],
    ["ParamArmLB"],
    ["ParamArmRB"],
  ];

  class Live2DMotionEngine {
    /**
     * @param {object} model  Live2DModel (pixi-live2d-display)
     * @param {object} [opts]
     * @param {boolean} [opts.petMode=false]   Em modo pet os movimentos são um
     *   pouco mais contidos para não "fugir" da janela compacta.
     * @param {number}  [opts.lipSyncGain=1.4] Multiplicador do RMS para abertura.
     */
    constructor(model, opts = {}) {
      this.model = model;
      this.internalModel = model?.internalModel || null;
      this.coreModel = this.internalModel?.coreModel || null;
      this.motionManager = this.internalModel?.motionManager || null;
      this.eyeBlink = this.internalModel?.eyeBlink || null;
      // NOTICE: neste build do pixi-live2d-display o passo automático de
      // expressão não roda (a expressão é "set" mas nunca aplicada ao core —
      // confirmado: em.update() manual aplica, o loop não chama). Então o motor
      // bombeia o expressionManager todo frame, como a Airi faz pelo hook.
      this.expressionManager = this.motionManager?.expressionManager || null;

      this.petMode = Boolean(opts.petMode);
      this.lipSyncGain = opts.lipSyncGain ?? 1.4;
      this.eyeTrackingEnabled = opts.eyeTracking ?? true;
      this.idleAnimationEnabled = opts.idleAnimation ?? true;
      this.autoBlinkEnabled = opts.autoBlink ?? true;
      this.headMotionScale = opts.headMotionScale ?? 1;
      this._moodHeadScale = 1;         // T3.4 — multiplicador de mood no head-sway (compõe c/ a slider)
      this.beatSyncEnabled = opts.beatSync ?? true;
      this.beatSyncStrength = opts.beatSyncStrength ?? 1;

      // --- T1.6: FSM de idle escalonado por tempo de silêncio ---
      // Estados por tempo ocioso: presente→relaxado→tédio→brincadeira→sonolento→
      // cochilo. Roda 100% no cliente; recupera na hora quando o usuário interage
      // (gesto/fala/cursor). Só escreve parâmetros DENTRO do idle e quando há
      // afundamento/cap ativo — fora disso é no-op total (zero impacto no baseline).
      this.idleFsmEnabled = opts.idleFsm ?? true;
      this._idleSince = performance.now();
      this._idleLevel = 0;        // 0..5
      this._idleEyeCap = 1;       // teto suavizado de abertura do olho (1 = normal)
      this._idleDroopY = 0;       // afundamento suavizado de cabeça/olhos (0..-0.5)
      this._idleSwayDamp = 1;     // encolhe o "swing" do idle ao cochilar (1 → ~0.15)
      this.onIdlePlay = null;     // callback p/ brincadeira solitária (nível 3)
      this.onIdleStateChange = null; // notificação opcional (level, nome)
      this._idlePlayNextAt = 0;   // próximo "brincar sozinha" (ms)
      // Carimbo de build — útil com __HINA_IDLE_DEBUG=true (HUD/console).
      // Confirma que o live2d-motion.js novo carregou (descarta "flick de janela velha").
      this.buildTag = "40";
      if (idleDebugOn()) {
        try { console.info("[Hina idle-fsm] build " + this.buildTag); } catch (_) {}
      }

      // --- Lip sync state ---
      this.audioLevel = 0;       // alvo cru vindo do RMS (0..1+)
      this.mouthValue = 0;       // valor suavizado escrito no parâmetro
      this.speaking = false;
      this.releaseRemainingMs = 0;
      this.lastForcedMouth = 0;
      this.RELEASE_DURATION_MS = 200; // cauda típica de um fonema

      // --- Phoneme lip sync targets (LS1-LS3) ---
      this.phonemeEnabled = opts.phonemeLipSync ?? false;
      this._phonemeTarget = { mouthForm: 0, mouthOpen: 1, cheek: 0 };
      // --- Face tracking (webcam): dirige boca + cabeça direto, sem áudio ---
      this._faceTarget = { mouthForm: 0, mouthOpen: 0, cheek: 0 };
      this._faceUntil = 0;       // performance.now() até quando a webcam dirige a boca
      this._phonemeForm = 0;     // valor suavizado de mouthForm
      this._phonemeCheek = 0;    // valor suavizado de cheek

      // --- Piscada procedural (porte do auto-eye-blink da Airi) ---
      // Substitui o eyeBlink linear do SDK: fecha rápido (75ms, easeOutQuad),
      // abre mais devagar (150-300ms, easeInQuad), a cada 3-8s. O baseline é
      // capturado no início da piscada e MULTIPLICADO pelo fator — expressões
      // que semicerram/fecham os olhos são respeitadas durante a piscada.
      this._blinkPhase = "wait";   // wait | closing | opening
      this._blinkNextAt = 0;       // quando inicia a próxima piscada (ms)
      this._blinkPhaseStart = 0;
      this._blinkOpenDuration = 0; // sorteado por piscada
      this._blinkBaseL = 1;
      this._blinkBaseR = 1;
      this.BLINK_CLOSE_MS = 75;
      this.BLINK_MIN_OPEN_MS = 150;
      this.BLINK_MAX_OPEN_MS = 300;
      this.BLINK_MIN_DELAY_MS = 3000;
      this.BLINK_MAX_DELAY_MS = 8000;

      // Lado do tilt pensativo (poses alternate) — troca a cada ativação fresca.
      this._tiltSide = 1;
      // Emoção da pose ativa (dedup de re-asserts da mesma emoção no hold).
      this._poseEmotion = null;

      // --- Eye focus / saccade state ---
      this.focusTarget = [0, 0];
      this.nextSaccadeAt = 0;
      this.lastSaccadeAt = 0;
      // Rastreio de cursor: alvo normalizado (-1..1) e até quando vale.
      this.cursorTarget = null;
      this.cursorExpiresAt = 0;
      this._directedGazeUntil = 0;
      this.CURSOR_HOLD_MS = 2200; // depois disso volta ao idle/saccade

      // Mola de foco da CABEÇA (criticamente amortecida). `focusTarget` é o valor
      // APLICADO (posição da mola); `_focusGoal` é o alvo desejado (cursor /
      // saccade idle / recentro). A mola persegue o alvo com aceleração do repouso
      // e frenagem suave — elimina o "tranco" do lerp de coeficiente fixo (que tem
      // velocidade máxima no 1º frame) e é independente de FPS (sub-passo fixo).
      // Os OLHOS perseguem `_focusGoal` direto (mais rápido) p/ liderar a cabeça,
      // que faz o smooth-pursuit atrás — como o par saccade(olho)+pursuit(cabeça).
      this._focusGoal = [0, 0];
      this._focusVel = [0, 0];
      this.FOCUS_STIFFNESS = 150; // ≈ crit. amortecida c/ damping 25 (settle ~0,3s)
      this.FOCUS_DAMPING = 25;
      this.FOCUS_EYE_TAU = 0.045; // constante de tempo do olho (rápido → lidera)
      this._focusDuck = 1;        // beat ativo → cabeça do foco cede p/ ~0.5

      // --- Sway de fala (porte do _updateSpeechMotion do VRM): envelope de
      // energia suave × senoides dessincronizadas. Sem impulsos/aleatoriedade.
      this._speechEnergy = 0;
      // --- Beat-sync: OSCILADOR DE FASE contínuo (sem alvos, sem mola) ---
      // O balanço é uma senoide ininterrupta — o mesmo tipo de curva do idle
      // da Hiyori, só que no tempo da música. Cada beat detectado só faz duas
      // coisas SUAVES: (re)alimenta o envelope de amplitude e corrige a fase
      // por TAXA (espalhada ao longo do próximo ciclo, nunca um salto). A
      // maquinaria anterior de segmentos+mola retargetava a cada detecção e
      // os micro-ajustes liam como "tremiliques".
      this._beatPhase = Math.PI / 2;  // fase (rad); começa num extremo
      this._beatSnapSide = 1;         // extremo do snap inicial alterna por rajada
      this._beatPeriod = 0.96;        // s por ciclo completo L→R→L (= 2 beats)
      this._beatAmp = 0;              // envelope aplicado (0..~1.3)
      this._beatAmpTarget = 0;        // amplitude do último beat (alvo do envelope)
      this.lastBeatAt = 0;
      this.beatLastInterval = 0;
      this.beatAvgInterval = null;    // EMA do intervalo entre beats (tempo)
      this._beatActive = false;       // beat dono da cabeça (suprime sway/pose/duck)
      this.BEAT_RELEASE_MS = 2600;    // sem batidas → envelope decai ao neutro
      this.BEAT_DEFAULT_INTERVAL = 480; // fallback até medir o tempo (125 BPM)

      // --- Suavização de gesto (porte do useMotionUpdatePluginBeatSync da Airi) ---
      // Mola criticamente amortecida que segue o valor cru da motion do SDK como
      // ALVO, dando aceleração/desaceleração no meio da transição em vez do salto
      // robótico. Maior stiffness = mais rápido; maior damping = menos balanço.
      this.SMOOTH_STIFFNESS = 120;
      this.SMOOTH_DAMPING = 16;
      this._smoothState = null; // [{id, pos, vel}] resolvido no setup

      // --- Clock próprio (segundos), independente do `now` do SDK ---
      this._lastFrame = performance.now() / 1000;

      this.params = {};
      this._origUpdate = null;
      this._origEyeBlinkUpdate = null;
      this._installed = false;
      // Pump do expressionManager do SDK (Fase B). A Fase C o desliga e assume
      // as expressões via frame hooks (controlador de blend exp3 próprio).
      this._pumpExpressionManager = true;
      // Hooks externos rodados todo frame (ex.: aplicação de expressões exp3).
      this._frameHooks = [];
      this.fidgetsEnabled = true;      // T2.3 — micro-gestos de postura no idle acordado
      this._lastMotionGroup = null;
      // Porte seletivo do N.E.K.O: cada motion registra somente as curvas de
      // Parameter que ela dirige. No fim de uma Ação de Idle restauramos esses
      // parâmetros, sem apagar expressões/overrides não pertencentes ao gesto.
      this._motionParameterIdsByGroup = new Map();
      this._idleActionActive = false;
      this._idleActionMotionGroup = null;
      this._postGestureSettleUntil = 0;
      this._lastIdleRestartAt = 0;
      // Classe de movimento do modelo. Live2D "completo" (Hiyori: Flick/Tap/Flick
      // Up/… — vários grupos) vs "limitado" (Mao/mao_pro: só Idle + 1 bucket). As
      // duas cobrem faixas de movimento diferentes e pedem estratégias de idle/
      // restart distintas; default = completo (caminho c4, conservador).
      this._limitedMotionModel = false;

      if (this.coreModel && this.motionManager) {
        this._resolveParams();
        this._detectMotionModelClass();
        this._resolveSmoothParams();
        this._installEyeBlinkGuard();
        this._installMotionFinishHook();
        this._installHook();
        this._tuneMotions();
      }
    }

    _motionIdleKey() {
      const mm = this.motionManager;
      return mm?.groups?.idle || mm?.groups?.Idle || "Idle";
    }

    _markPostGestureSettle(durationMs = 1600) {
      this._postGestureSettleUntil = performance.now() + durationMs;
    }

    _trackMotionParameterIds(data, group) {
      if (!group || !Array.isArray(data?.Curves)) return;
      const key = String(group);
      const ids = new Set(this._motionParameterIdsByGroup.get(key) || []);
      for (const curve of data.Curves) {
        if (curve?.Target === "Parameter" && curve.Id) ids.add(String(curve.Id));
      }
      if (ids.size) this._motionParameterIdsByGroup.set(key, ids);
    }

    _motionParameterIds(group) {
      const tracked = group && this._motionParameterIdsByGroup.get(String(group));
      if (tracked?.size) return tracked;

      // Fallback conservador para motion já pré-carregada antes do interceptor:
      // só parâmetros corporais/foco que o motor da Hina já reconhece.
      const ids = new Set();
      for (const state of this._smoothState || []) if (state?.id) ids.add(state.id);
      for (const key of ["angleX", "angleY", "angleZ", "eyeBallX", "eyeBallY", "bodyAngleX", "bodyAngleZ"]) {
        if (this.params?.[key]) ids.add(this.params[key]);
      }
      return ids;
    }

    _restoreMotionParameters(group) {
      const coreModel = this.coreModel;
      if (!coreModel || !group) return 0;
      const ids = this._motionParameterIds(group);
      let count = 0;
      let parameterCount = 0;
      try { parameterCount = Number(coreModel.getParameterCount?.()) || 0; } catch (_) {}

      for (const id of ids) {
        try {
          const index = coreModel.getParameterIndex(id);
          if (!Number.isInteger(index) || index < 0 || (parameterCount && index >= parameterCount)) continue;
          const value = typeof coreModel.getParameterDefaultValue === "function"
            ? coreModel.getParameterDefaultValue(index)
            : coreModel?._model?.parameters?.defaultValues?.[index]
              ?? coreModel?.parameters?.defaultValues?.[index];
          if (!Number.isFinite(value)) continue;
          coreModel.setParameterValueById(id, value);
          count++;
        } catch (_) {}
      }
      if (count) {
        // Fora do ticker, o Cubism recarregaria o baseline anterior no próximo
        // frame. Salvar aqui torna a neutralização determinística.
        try { coreModel.saveParameters?.(); } catch (_) {}
      }
      return count;
    }

    beginIdleAction() {
      this._idleActionActive = true;
      this._idleActionMotionGroup = null;
    }

    /**
     * Encerra uma Ação de Idle sem iniciar motion Idle contínua.
     * ON é controle negativo: nenhuma mutação visual. OFF para a one-shot,
     * limpa o gaze transitório e restaura só as curvas pertencentes ao gesto.
     */
    finishIdleAction() {
      const current = this.motionManager?.state?.currentGroup ?? null;
      const group = current && !this._isIdleGroupName(current)
        ? current
        : this._idleActionMotionGroup;
      this._idleActionActive = false;
      this._idleActionMotionGroup = null;
      if (this.idleAnimationEnabled) return false;

      this._settleNeutralWithoutIdle(group, { clearDirectedGaze: true });
      return true;
    }

    _settleNeutralWithoutIdle(group, options = {}) {
      try { this.motionManager?.stopAllMotions?.(); } catch (_) {}
      // O gaze enviado pela ação é transitório e precisa terminar junto dela.
      // Cursor/webcam usam o mesmo canal, mas continuam donos do alvo: não os
      // descartamos ao neutralizar a motion.
      if (options.clearDirectedGaze && this._directedGazeUntil) this.lookAway();
      this.focusTarget = [0, 0];
      this._focusGoal = [0, 0];
      this._focusVel = [0, 0];
      this.nextSaccadeAt = 0;
      this.lastSaccadeAt = 0;
      this._lastMotionGroup = null;
      this._stuckGestureSince = 0;
      this._postGestureSettleUntil = 0;
      this._resetSmoothState();
      this._restoreMotionParameters(group);
    }

    // Classifica o modelo pelo nº de grupos de motion NÃO-idle declarados no
    // model3. ≤1 → "limitado" (Mao/mao_pro: Idle + ""/TapBody); ≥2 → "completo"
    // (Hiyori/shizuku: Flick/Tap/FlickUp/…). Os idles do modelo limitado têm fade
    // e sway gentil (mola pós-gesto basta); os do completo fazem loop sem fade e
    // dependem da mola contínua de idle p/ não flicar no wrap do loop.
    _detectMotionModelClass() {
      const defs = this.motionManager?.definitions || {};
      const nonIdle = Object.keys(defs).filter((g) => String(g).toLowerCase() !== "idle");
      this._limitedMotionModel = nonIdle.length <= 1;
      // Modelos sem grupo "Idle" (ex.: imports / JaneDoe e changli legados) não
      // têm motion que devolva a boca ao repouso — o release do lip sync largava
      // o ParamMouthOpenY no último valor (boca travada aberta). Guardado abaixo.
      this._hasIdleGroup = Object.keys(defs).some((g) => String(g).toLowerCase() === "idle");
    }

    _resetSmoothState() {
      const states = this._smoothState;
      if (!states) return;
      for (const s of states) {
        s.pos = null;
        s.vel = 0;
      }
    }

    // Zera slots (mantém o array) p/ loadMotion recriar com strip no createMotion.
    _invalidateIdleMotionCache(idleKey) {
      const mm = this.motionManager;
      const key = idleKey || this._motionIdleKey();
      const count = mm?.definitions?.[key]?.length || 0;
      if (!mm?.motionGroups || count <= 0) return;
      mm.motionGroups[key] = new Array(count);
      try { mm.stopAllMotions?.(); } catch (_) {}
    }

    _installMotionFinishHook() {
      const mm = this.motionManager;
      if (!mm?.on || this._motionFinishHookInstalled) return;
      this._onMotionFinish = () => {
        const finishedGroup = mm?.state?.currentGroup ?? null;
        if (
          this._idleActionActive
          && finishedGroup
          && !this._isIdleGroupName(finishedGroup)
        ) {
          this._idleActionMotionGroup = finishedGroup;
        }
        if (!this.idleAnimationEnabled) return;
        this._markPostGestureSettle();
        this._resetSmoothState();
        // Limitado (Mao): SDK já chama startRandomMotion(Idle) no mesmo update —
        // evitar restart duplo que resetava mtn_01 no frame 0 (balanço “sumia”).
        if (this._limitedMotionModel) return;
        // Completo (Hiyori, c4): nudge se ficou sem grupo ativo após o gesto.
        queueMicrotask(() => {
          if (!this.idleAnimationEnabled) return;
          const state = mm.state;
          if (state?.currentGroup !== undefined) return;
          if (state?.shouldRequestIdleMotion && !state.shouldRequestIdleMotion()) return;
          this._restartIdleMotion();
        });
      };
      mm.on("motionFinish", this._onMotionFinish);
      this._motionFinishHookInstalled = true;
    }

    // Prefixo `_` invalida o param p/ o SDK (hack Airi) — foco/blink/pose ficam donos.
    _stripIdleMotionEyeCurves(data, group) {
      if (!data || String(group || "").toLowerCase() !== "idle") return data;
      if (!Array.isArray(data.Curves)) return data;
      let copy;
      try { copy = JSON.parse(JSON.stringify(data)); } catch (_) { return data; }
      for (const curve of copy.Curves) {
        if (curve?.Id && IDLE_MOTION_EYE_STRIP.has(curve.Id)) curve.Id = `_${curve.Id}`;
      }
      return copy;
    }

    // O eyeBlink do SDK (rampas lineares) é totalmente neutralizado: a piscada
    // procedural em _updateBlink assume em idle, e gestos continuam trazendo
    // blink nas próprias curvas de olho.
    _installEyeBlinkGuard() {
      if (!this.eyeBlink || this._eyeBlinkGuardInstalled) return;
      // ACHADO (bundle pixi-live2d-display): o InternalModel chama
      // `eyeBlink.updateParameters(coreModel, dt)` — NUNCA `.update`. O guard antigo só
      // sobrescrevia `.update` (método que o SDK não chama) e, pior, dava early-return
      // quando `.update` nem existia → o blink do SDK NUNCA era desligado. Ele roda DEPOIS
      // do meu hook (depois do eye-cap) e, como as curvas de olho da idle motion são
      // removidas, dispara a piscada no timer dele POR CIMA do olho fechado no sono: o
      // "abre/fecha rápido" (flick). Neutralizamos o método REAL (updateParameters) + o
      // `.update` por segurança. A piscada da Hina continua via _updateBlink procedural.
      if (typeof this.eyeBlink.updateParameters === "function") {
        this._origEyeBlinkUpdateParams = this.eyeBlink.updateParameters.bind(this.eyeBlink);
        this.eyeBlink.updateParameters = () => {};
      }
      if (typeof this.eyeBlink.update === "function") {
        this._origEyeBlinkUpdate = this.eyeBlink.update.bind(this.eyeBlink);
        this.eyeBlink.update = () => {};
      }
      this._eyeBlinkGuardInstalled = true;
    }

    // Gestos factory (Hiyori): Loop=true, sem fade no JSON. Desliga loop, injeta
    // fade in/out programático (Fix 1 do handoff + camada B flip). Idle: crossfade
    // longo entre variantes.
    _tuneMotions() {
      const mm = this.motionManager;
      if (!mm) return;
      const tune = (motion, group) => {
        if (!motion) return;
        const isIdle = String(group || "").toLowerCase() === "idle";
        try {
          if (!isIdle) {
            if (typeof motion.setIsLoop === "function") motion.setIsLoop(false);
            motion.setFadeInTime?.(GESTURE_FADE_IN_S);
            motion.setFadeOutTime?.(GESTURE_FADE_OUT_S);
          } else {
            // Limitado (Mao): loop interno do idle (mtn_01 com fade próprio, sway
            // gentil). Completo (Hiyori, c4): NÃO força loop — deixa o SDK trocar
            // de variante de idle; a mola contínua de idle suaviza o wrap.
            if (this._limitedMotionModel && typeof motion.setIsLoop === "function") {
              motion.setIsLoop(true);
            }
            motion.setFadeInTime?.(IDLE_CROSSFADE_S);
            motion.setFadeOutTime?.(IDLE_CROSSFADE_S);
          }
        } catch (_) {}
      };

      // 1) Motions já carregadas (ex.: idle inicial).
      const groups = mm.motionGroups || {};
      for (const g in groups) for (const m of groups[g] || []) tune(m, g);

      // 2) Intercepta a criação das próximas (gestos são lazy-loaded no 1º play).
      if (typeof mm.createMotion === "function" && !mm._tunedCreate) {
        const orig = mm.createMotion.bind(mm);
        mm.createMotion = (data, group, definition) => {
          this._trackMotionParameterIds(data, group);
          const patched = this._stripIdleMotionEyeCurves(data, group);
          const motion = orig(patched, group, definition);
          tune(motion, group);
          return motion;
        };
        mm._tunedCreate = true;
      }

      // Idles já instanciadas no load: invalida cache p/ recriar com strip de olhos.
      const idleKey = this._motionIdleKey();
      if (this._limitedMotionModel) {
        // Limitado (Mao): invalida 1× (evita loop de refresh); restart só no gap.
        const hadCached = mm.motionGroups?.[idleKey]?.some(Boolean);
        if (hadCached && !mm._idleEyeStripDone) {
          this._invalidateIdleMotionCache(idleKey);
          mm._idleEyeStripDone = true;
          this._restartIdleMotion(idleKey);
        } else if (!mm?.state?.currentGroup && this.idleAnimationEnabled) {
          this._restartIdleMotion(idleKey);
        }
      } else {
        // Completo (Hiyori, c4): invalida e reinicia o idle no setup.
        if (mm.motionGroups?.[idleKey]?.some(Boolean)) {
          this._invalidateIdleMotionCache(idleKey);
        }
        this._restartIdleMotion(idleKey);
      }
    }

    _restartIdleMotion(idleKey) {
      if (!this.idleAnimationEnabled) return;
      const mm = this.motionManager;
      const key = idleKey || this._motionIdleKey();
      // Limitado (Mao): debounce + skip-se-tocando evita loop de refresh. Completo
      // (Hiyori, c4): sem guarda — o SDK/crossfade cuida das variantes de idle.
      if (this._limitedMotionModel) {
        const now = performance.now();
        if (this._isIdleGroupName(mm?.state?.currentGroup) && mm?.playing) return;
        if (now - (this._lastIdleRestartAt || 0) < 800) return;
        this._lastIdleRestartAt = now;
      }
      const IDLE = global.PIXI?.live2d?.MotionPriority?.IDLE ?? 1;
      try {
        if (typeof mm?.startRandomMotion === "function") {
          mm.startRandomMotion(key, IDLE);
        } else {
          this.model?.motion?.(key, undefined, IDLE);
        }
      } catch (_) {}
    }

    _isIdleGroupName(group) {
      if (!group) return false;
      const idleKey = this._motionIdleKey();
      return group === idleKey || String(group).toLowerCase() === "idle";
    }

    // Gesto one-shot termina → SDK limpa currentGroup e pede Idle; se o cache
    // Idle foi apagado errado ou a mola prende pose, garantimos retomada.
    _ensureIdleAfterGesture() {
      if (!this.idleAnimationEnabled) return;
      const mm = this.motionManager;
      const current = mm?.state?.currentGroup ?? null;
      const idleKey = this._motionIdleKey();

      if (this._isIdleGroupName(current)) {
        this._lastMotionGroup = current;
        this._stuckGestureSince = 0;
        return;
      }

      if (current) {
        this._lastMotionGroup = current;
        const finished = typeof mm.isFinished === "function" && mm.isFinished() && !mm.playing;
        if (!finished) { this._stuckGestureSince = 0; return; }
        if (!this._limitedMotionModel) {
          // Completo (Hiyori, c4): gesto terminou mas o grupo não limpou → reinicia já.
          this._resetSmoothState();
          this._restartIdleMotion(idleKey);
          this._lastMotionGroup = idleKey;
        } else {
          // Limitado (Vivian/Mao): o SDK COSTUMA retomar a idle sozinho — damos ~400ms
          // de janela. Se o gesto FORCE ficar TRAVADO (Vivian após um poke "não voltava
          // ao normal"), reiniciamos a idle nós mesmos. O delay evita o restart-duplo
          // frame-0 do Mao: se o SDK já retomou, o grupo vira "idle" e o early-return
          // de _isIdleGroupName acima zera o contador antes dos 400ms.
          const now = performance.now();
          if (!this._stuckGestureSince) this._stuckGestureSince = now;
          else if (now - this._stuckGestureSince > 400) {
            this._resetSmoothState();
            this._restartIdleMotion(idleKey);
            this._lastMotionGroup = idleKey;
            this._stuckGestureSince = 0;
          }
        }
        return;
      }

      const prev = this._lastMotionGroup;
      const prevWasGesture = prev && !this._isIdleGroupName(prev);
      if (prevWasGesture) {
        this._resetSmoothState();
        this._markPostGestureSettle();
        this._restartIdleMotion(idleKey);
        this._lastMotionGroup = idleKey;
      }
    }

    // Resolve cada nome lógico para um ID real existente no modelo.
    _resolveParams() {
      for (const key in PARAM_CANDIDATES) {
        this.params[key] = this._pickExisting(PARAM_CANDIDATES[key]);
      }
      // Lip-sync por vogal: modelos como a Vivian abrem a boca pelo ParamA (que
      // fica no grupo LipSync junto do ParamMouthOpenY). O mouth resolvido pega o
      // ParamMouthOpenY (1º candidato), que nesses modelos quase não deforma a
      // boca — então dirigimos o ParamA em paralelo quando existe e é distinto.
      const vowelA = this._pickExistingOrNull(["ParamA"]);
      this.params.mouthVowel = (vowelA && vowelA !== this.params.mouth) ? vowelA : null;
    }

    // Monta o estado da mola só para os parâmetros de gesto que o modelo tem.
    // Parâmetros ausentes são pulados (não geram no-ops nem estado morto).
    _resolveSmoothParams() {
      const states = [];
      for (const candidates of SMOOTH_PARAM_CANDIDATES) {
        const id = this._pickExistingOrNull(candidates);
        if (id) states.push({ id, pos: null, vel: 0 });
      }
      this._smoothState = states;
    }

    // Como _pickExisting, mas devolve null quando nenhum candidato existe (em vez
    // do fallback candidates[0]). Usado pela suavização p/ não tocar params ausentes.
    _pickExistingOrNull(candidates) {
      let count = 0;
      try { count = this.coreModel.getParameterCount(); } catch (_) {}
      for (const id of candidates) {
        try {
          const idx = this.coreModel.getParameterIndex(id);
          if (idx >= 0 && (count === 0 || idx < count)) return id;
        } catch (_) {}
      }
      return null;
    }

    _pickExisting(candidates) {
      // NOTICE: o Cubism NUNCA retorna -1 em getParameterIndex — para um ID
      // inexistente ele registra o parâmetro numa região "not-exist" e devolve
      // um índice >= getParameterCount(). Portanto a checagem de existência
      // correta é `índice < parameterCount`, não `>= 0`.
      // (Confirmado via probe: core._parameterIds + getParameterCount()=45.)
      let count = 0;
      try { count = this.coreModel.getParameterCount(); } catch (_) {}
      for (const id of candidates) {
        try {
          const idx = this.coreModel.getParameterIndex(id);
          if (idx >= 0 && (count === 0 || idx < count)) return id;
        } catch (_) {
          // getParameterIndex pode lançar p/ ID desconhecido em algumas versões.
        }
      }
      return candidates[0]; // fallback: escritas viram no-op se não existir
    }

    _normaliseSdkTime(now) {
      let t = Number(now);
      if (!Number.isFinite(t)) t = performance.now() / 1000;
      // pixi-live2d-display passa segundos; este guard cobre runtimes que passem ms.
      if (t > 100000) t /= 1000;
      return t;
    }

    _makeFrameContext(now) {
      const t = this._normaliseSdkTime(now);
      let dt = this._lastFrame ? t - this._lastFrame : 0;
      this._lastFrame = t;
      dt = clamp(dt, 0, 0.1);
      return {
        now: t,
        dt,
        handled: false,
        isIdleMotion: this._isIdleMotion(),
      };
    }

    _isIdleMotion() {
      const mm = this.motionManager;
      const current = mm?.state?.currentGroup;
      if (!current) return false;
      if (this._isIdleGroupName(current)) return true;

      const selected = localStorage.getItem("selected-runtime-motion-group");
      return Boolean(selected && String(current) === selected);
    }

    // Hook no update do motionManager, espelhando a Airi:
    // update original do SDK -> post plugins -> final plugins.
    // (Sem estágio pre: o beat aplicado antes do update era comido pelos fades
    // das curvas e acumulava nos gaps de motion — hoje roda no post, gateado.)
    _installHook() {
      const mm = this.motionManager;
      this._origUpdate = mm.update.bind(mm);
      mm.update = (coreModel, now) => {
        // STEP DEBUG: relógio virtual — congela a motion idle; cada Enter avança UM frame
        // (1/60s). Determinístico (não depende do tempo real entre teclas). Liga via
        // stepDebugOn(); avança via stepDebugAdvance(); sai via stepDebugOff().
        if (this._stepMode) {
          if (!Number.isFinite(this._stepNow)) this._stepNow = this._lastFrame || (performance.now() / 1000);
          if (this._stepPending) { this._stepNow += 1 / 60; this._stepPending = false; this._stepLogNow = true; }
          now = this._stepNow;
        }
        const ctx = this._makeFrameContext(now);
        // DEBUG (só com __HINA_IDLE_DEBUG): snapshot de params p/ achar flick no sono.
        if (idleDebugOn()) {
          try {
            const _ids = this._dbgIds || (this._dbgIds = ["ParamEyeLOpen","ParamEyeROpen","ParamEyeBallX","ParamEyeBallY","ParamEyeLSmile","ParamEyeRSmile","ParamBrowLY","ParamBrowRY","ParamBrowLForm","ParamBrowRForm","ParamAngleX","ParamAngleY","ParamAngleZ","ParamBodyAngleX","ParamBodyAngleY","ParamBodyAngleZ","ParamCheek","ParamMouthOpenY","ParamMouthForm"]);
            const _s = {};
            for (let _i = 0; _i < _ids.length; _i++) { try { _s[_ids[_i]] = coreModel.getParameterValueById(_ids[_i]); } catch (_) {} }
            this._dbgSnap = _s;
          } catch (_) {}
        }
        try {
          if (!ctx.handled) {
            // Sono profundo da FSM (lv5/cochilo): suprime o idle motion (o "swing")
            // exatamente como o toggle "Idle" desligado — para a animação de idle.
            // Ao acordar (lv<5), _updateIdleFsm reinicia o idle (swing volta ao normal).
            const deepSleep = this.idleFsmEnabled && (this._idleLevel || 0) >= 5;
            if ((!this.idleAnimationEnabled || deepSleep) && ctx.isIdleMotion) {
              this.motionManager?.stopAllMotions?.();
              ctx.handled = true;
            } else {
              const result = this._origUpdate(coreModel, now);
              if (result) ctx.handled = true;
            }
          }

          ctx.isIdleMotion = this._isIdleMotion();
          this._ensureIdleAfterGesture();
          this._runPostPlugins(coreModel, ctx);
          this._runFinalPlugins(coreModel, ctx);
          if (this._stepLogNow) { this._stepLogNow = false; try { this._stepLogFrame(coreModel); } catch (_) {} }
        } catch (e) {
          // Nunca deixa a animação derrubar o render.
          console.warn("[Live2DMotionEngine] frame error:", e);
        }
        return ctx.handled;
      };
      this._installed = true;
    }

    // ----------------------------------------------------------------
    // STEP DEBUG: avanço frame-a-frame da animação no sono (acha o frame do flick)
    // ----------------------------------------------------------------
    stepDebugOn() {
      this._stepMode = true;
      this._stepNow = this._lastFrame || (performance.now() / 1000);
      this._stepCount = 0;
      this._stepPending = false;
      this._stepLogNow = false;
      this._stepPrev = null;
      // Reproduz o regime do flick AGORA (sem esperar 90s): força sono profundo (lvl5).
      this._idleSince = performance.now() - 100000;
      this._idleLevel = 5;
      this._idleEyeCap = 0.05;
      this._idleDroopY = -0.5;
      this._idleSwayDamp = 0.04;
      try { console.log("%c[STEP] frame-a-frame LIGADO (sono forçado lvl5). Enter = +1 frame. stepDebugOff() p/ sair.", "color:#0ff;font-weight:bold"); } catch (_) {}
    }
    stepDebugOff() {
      this._stepMode = false; this._stepPending = false; this._stepLogNow = false;
      this._lastFrame = performance.now() / 1000; // evita dt gigante no 1º frame normal
      try { console.log("%c[STEP] frame-a-frame DESLIGADO (animação normal).", "color:#0ff"); } catch (_) {}
    }
    stepDebugAdvance() { if (this._stepMode) this._stepPending = true; }

    _stepLogFrame(coreModel) {
      let ids = this._dbgAllIds;
      if (!ids) {
        try { if (Array.isArray(coreModel._parameterIds) && coreModel._parameterIds.length) ids = coreModel._parameterIds.slice(); } catch (_) {}
        if (!ids) { try { const n = coreModel.getParameterCount(); const a = []; for (let i = 0; i < n; i++) { const p = coreModel.getParameterId(i); a.push((p && p.getString) ? p.getString().s : ("p" + i)); } ids = a; } catch (_) { ids = []; } }
        this._dbgAllIds = ids;
      }
      const snap = {};
      for (let i = 0; i < ids.length; i++) { try { snap[ids[i]] = coreModel.getParameterValueById(ids[i]); } catch (_) {} }
      this._stepCount = (this._stepCount || 0) + 1;
      const prev = this._stepPrev;
      const changed = [];
      if (prev) for (const id of ids) { const d = snap[id] - (prev[id] ?? snap[id]); if (Math.abs(d) > 0.0005) changed.push([id, snap[id], d]); }
      changed.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
      this._stepPrev = snap;
      const head = "[STEP " + this._stepCount + "] t=" + this._stepNow.toFixed(3) + "s — " + changed.length + " params mudaram";
      const top = changed.slice(0, 12).map(([id, v, d]) => id.replace("Param", "") + "=" + v.toFixed(3) + "(" + (d > 0 ? "+" : "") + d.toFixed(3) + ")").join("  ");
      this._stepLine = head + (top ? " | " + top : " | (nada mudou)");
      try { console.log("%c" + head, "color:#fc0;font-weight:bold"); if (top) console.log("%c   " + top, "color:#fc0"); } catch (_) {}
      try { fetch("/debug/idle-log", { method: "POST", headers: { "Content-Type": "text/plain" }, body: head + "\n  " + top }).catch(() => {}); } catch (_) {}
    }

    // ----------------------------------------------------------------
    // API pública
    // ----------------------------------------------------------------

    /** Nível de áudio cru (RMS 0..1) para o lip sync. */
    setAudioLevel(rms) {
      this.audioLevel = clamp(rms * this.lipSyncGain, 0, 1);
    }

    /** Liga/desliga a fala. Ao desligar, inicia a cauda de release. */
    setSpeaking(on) {
      if (this.speaking && !on) {
        this.lastForcedMouth = this.mouthValue;
        this.releaseRemainingMs = this.RELEASE_DURATION_MS;
      }
      this.speaking = Boolean(on);
      if (!on) this.audioLevel = 0;
    }

    /**
     * Faz a cabeça/olhos seguirem um ponto da tela (coordenadas de cliente).
     * Convertemos para o espaço normalizado -1..1 do canvas.
     */
    lookAt(clientX, clientY, canvas) {
      if (!this.eyeTrackingEnabled) return;
      const el = canvas || this.model?.view || null;
      const rect = el?.getBoundingClientRect?.();
      if (!rect || !rect.width || !rect.height) return;
      const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((clientY - rect.top) / rect.height) * 2 - 1;
      // y invertido: tela cresce p/ baixo, foco do modelo cresce p/ cima.
      this.cursorTarget = [clamp(nx, -1, 1), clamp(-ny, -1, 1)];
      this.cursorExpiresAt = performance.now() + this.CURSOR_HOLD_MS;
      this._directedGazeUntil = 0;
    }

    /**
     * T2.2 — Olhar dirigido: faz a Hina olhar um ponto JÁ normalizado (-1..1; x→direita,
     * y→cima) por holdMs. Reusa EXATAMENTE o canal do cursor (cursorTarget/cursorExpiresAt),
     * que o _updateFocus já prioriza sobre o saccade — então NÃO há lógica de movimento
     * nova: só direciona o olhar/cabeça que já existem. Respeita o toggle eyeTracking
     * (igual ao lookAt). Sem alvo válido → no-op.
     */
    setGazeTarget(nx, ny, holdMs) {
      if (!this.eyeTrackingEnabled) return;
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
      this.cursorTarget = [clamp(nx, -1, 1), clamp(ny, -1, 1)];
      this.cursorExpiresAt = performance.now() + (holdMs > 0 ? holdMs : this.CURSOR_HOLD_MS);
      this._directedGazeUntil = this.cursorExpiresAt;
    }

    /** Volta imediatamente ao comportamento idle (saccades). */
    lookAway() {
      this.cursorTarget = null;
      this.cursorExpiresAt = 0;
      this._directedGazeUntil = 0;
    }

    setPetMode(on) {
      this.petMode = Boolean(on);
    }

    setLipSyncGain(value) {
      const n = Number(value);
      if (Number.isFinite(n)) this.lipSyncGain = clamp(n, 0.1, 20);
    }

    setPhonemeEnabled(on) {
      this.phonemeEnabled = Boolean(on);
      if (!this.phonemeEnabled) {
        this._phonemeTarget = { mouthForm: 0, mouthOpen: 1, cheek: 0 };
      }
    }

    /**
     * Recebe targets de phoneme lip sync (mouthForm, mouthOpen, cheek) do
     * PhonemeLipSync e suaviza para aplicação por frame.
     */
    setPhonemeTarget(targets) {
      if (!this.phonemeEnabled) return;
      if (targets && typeof targets === "object") {
        this._phonemeTarget = {
          mouthForm: Number(targets.mouthForm) || 0,
          mouthOpen: Number(targets.mouthOpen) ?? 1,
          cheek: Number(targets.cheek) || 0,
        };
      }
    }

    /**
     * Webcam (face tracking): dirige forma + abertura da boca diretamente,
     * ignorando phonemeEnabled e o nível de áudio, e move a cabeça/olhos pelo
     * canal de cursor. Consumido em _updateLipSync/_updateFocus enquanto ativo.
     */
    setFaceTarget(targets) {
      if (!targets || typeof targets !== "object") return;
      this._faceTarget = {
        mouthForm: Number(targets.mouthForm) || 0,
        mouthOpen: clamp(Number(targets.mouthOpen) || 0, 0, 1),
        cheek: Number(targets.cheek) || 0,
      };
      this._faceUntil = performance.now() + 300;
      // Cabeça/olhos seguem a cabeça do usuário (reusa o canal de cursor/foco).
      const yaw = Number(targets.headYaw);
      const pitch = Number(targets.headPitch);
      if (Number.isFinite(yaw) && Number.isFinite(pitch)) {
        this.cursorTarget = [clamp(yaw, -1, 1), clamp(-pitch, -1, 1)];
        this.cursorExpiresAt = this._faceUntil;
        this._directedGazeUntil = 0;
      }
    }

    setEyeTracking(on) {
      this.eyeTrackingEnabled = Boolean(on);
      if (!this.eyeTrackingEnabled) this.lookAway();
    }

    setIdleAnimation(on) {
      this.idleAnimationEnabled = Boolean(on);
      if (!this.idleAnimationEnabled) {
        const current = this.motionManager?.state?.currentGroup ?? null;
        this._settleNeutralWithoutIdle(current);
      } else {
        this._restartIdleMotion();
      }
    }

    setAutoBlink(on) {
      this.autoBlinkEnabled = Boolean(on);
    }

    setHeadMotionScale(value) {
      const n = Number(value);
      if (Number.isFinite(n)) this.headMotionScale = clamp(n, 0, 2);
    }

    /** T3.4 — ajusta o intervalo entre piscadas (ms). Canal próprio do mood, sem slider
     *  do usuário. (No sono, a piscada já é suprimida pela FSM — sem conflito.) */
    setBlinkRate(minMs, maxMs) {
      const lo = Math.max(400, Number(minMs) || this.BLINK_MIN_DELAY_MS);
      const hi = Math.max(lo + 200, Number(maxMs) || this.BLINK_MAX_DELAY_MS);
      this.BLINK_MIN_DELAY_MS = lo;
      this.BLINK_MAX_DELAY_MS = hi;
    }

    /**
     * T3.4 — acopla o embodiment ao mood (PAD) de forma SUTIL e SEGURA: energia↑ → pisca
     * mais alerta + cabeça do idle mais viva; energia/valência↓ → pisca devagar (sonolenta)
     * + cabeça mais calma. NÃO sobrescreve as sliders do usuário — usa o canal de blink
     * (sem slider) e o multiplicador _moodHeadScale (compõe com a slider de cabeça).
     */
    applyMoodEmbodiment(mood) {
      if (!mood || typeof mood !== "object") return;
      const energy = clamp(Number(mood.energy ?? 0.5), 0, 1);
      const valence = clamp(Number(mood.valence ?? 0.5), 0, 1);
      // Blink: energia alta → intervalo menor (mais alerta); baixa → maior (sonolenta).
      const f = clamp(1 + (0.5 - energy), 0.5, 1.6); // energy 1→0.5, 0→1.5
      this.setBlinkRate(2400 * f, 7000 * f);
      // Cabeça do idle: ~0.7..1.25 por energia+valência (multiplicador, sem clobber).
      this._moodHeadScale = clamp(0.85 + 0.25 * (energy - 0.5) + 0.15 * (valence - 0.5), 0.6, 1.3);
    }

    setBeatSync(on) {
      this.beatSyncEnabled = Boolean(on);
      if (!this.beatSyncEnabled) {
        // Solta o envelope: o balanço decai suavemente até zero (sem corte).
        this._beatAmpTarget = 0;
        this.lastBeatAt = 0;
        this.beatAvgInterval = null;
      }
    }

    setBeatSyncStrength(value) {
      const n = Number(value);
      if (Number.isFinite(n)) this.beatSyncStrength = clamp(n, 0, 2);
    }

    setIdleFsm(on) {
      this.idleFsmEnabled = Boolean(on);
      // Desligar: solta os alvos (olhos/cabeça voltam ao normal). Ligar: zera o
      // relógio para começar do estado "presente".
      this._idleLevel = 0;
      this._idleEyeCap = 1;
      this._idleDroopY = 0;
      this._idlePlayNextAt = 0;
      if (this.idleFsmEnabled) this._idleSince = performance.now();
    }

    applySettings(settings) {
      if (!settings) return;
      this.setEyeTracking(settings.eyeTracking);
      this.setIdleAnimation(settings.idleAnimation);
      this.setAutoBlink(settings.autoBlink);
      this.setLipSyncGain(settings.lipSyncGain);
      this.setHeadMotionScale(settings.headMotionScale);
      this.setBeatSync(settings.beatSync);
      this.setBeatSyncStrength(settings.beatSyncStrength);
      this.setPhonemeEnabled(settings.phonemeLipSync);
      // T1.6 — default true p/ não desligar a FSM em settings antigos sem a chave.
      this.setIdleFsm(settings.idleFsm ?? true);
    }

    /**
     * Agenda um beat detectado por áudio externo/TTS.
     * @param {object} [beat]
     * @param {number} [beat.confidence=1] confiança do detector (0..1) —
     *   module a amplitude em ±30%. (`beat.energy` é aceito mas não altera a
     *   amplitude: o balanço usa graus fixos, como o idle.)
     */
    scheduleBeat(beat = {}) {
      if (!this.beatSyncEnabled || this.beatSyncStrength <= 0) return false;
      return this._scheduleBeat(beat, 1);
    }

    /** Dispara uma batida visual forte para diagnóstico, ignorando toggles. */
    testBeat(beat = {}) {
      return this._scheduleBeat({ energy: 1.4, confidence: 1, ...beat }, 2.2);
    }

    /**
     * Registra uma batida no oscilador. Um beat só faz duas coisas SUAVES:
     * (1) realimenta o envelope de amplitude e o tempo (EMA do intervalo);
     * (2) agenda uma correção de fase consumida POR TAXA ao longo do próximo
     * ciclo — para os beats caírem nos extremos do balanço, sem nunca saltar.
     */
    _scheduleBeat(beat = {}, gainScale = 1) {
      const now = performance.now();
      if (this.lastBeatAt && now - this.lastBeatAt < 80) return false;

      const confidence = clamp01(Number(beat.confidence ?? 1) || 0);
      const modeScale = this.petMode ? 0.82 : 1;
      // Amplitude achatada: confiança module só ±30% — todo beat detectado
      // alimenta o balanço de forma consistente (graus fixos, como o idle).
      const amp = clamp(this.beatSyncStrength * modeScale * gainScale * (0.7 + 0.3 * confidence), 0, 1.3);

      // Tempo: EMA do intervalo entre beats → período do ciclo (2 beats/ciclo).
      let interval = this.BEAT_DEFAULT_INTERVAL;
      if (this.lastBeatAt && now - this.lastBeatAt < 2500) {
        interval = clamp(now - this.lastBeatAt, 220, 2000);
        this.beatLastInterval = interval;
      } else if (this.beatLastInterval) {
        interval = this.beatLastInterval;
      }
      this.lastBeatAt = now;
      this.beatAvgInterval = this.beatAvgInterval == null
        ? interval
        : this.beatAvgInterval * 0.7 + interval * 0.3;
      this._beatPeriod = clamp((2 * this.beatAvgInterval) / 1000, 0.6, 3.2);

      const wasQuiet = this._beatAmp < 0.05;
      this._beatAmpTarget = amp;

      if (wasQuiet) {
        // Nada visível ainda: pode posicionar a fase num extremo direto (o
        // envelope sobe do zero, então não há salto perceptível). O extremo
        // ALTERNA a cada rajada — resetar sempre em π/2 fazia toda rajada
        // começar a bailar para o MESMO lado ("guinadas para um lado").
        this._beatSnapSide = -(this._beatSnapSide || 1);
        this._beatPhase = this._beatSnapSide > 0 ? Math.PI / 2 : (3 * Math.PI) / 2;
      }
      // SEM correção de fase por beat. Toda variante dela (puxar p/ o extremo
      // mais próximo, clampar o passo) interferia com a travessia: o detector
      // dispara várias vezes por ciclo (gap mínimo 110ms) e atrasado em
      // relação ao pico visual, então as correções desaceleravam o balanço
      // perto do centro e ele "pendurava" num lado — a guinada unilateral de
      // sempre. A senoide livre no TEMPO da música (período via EMA) é
      // estruturalmente bilateral: cruza o centro a cada meio período, sempre.
      // (Mesma garantia do fix por posição da abordagem de segmentos: nada
      // pode interferir contra a alternância.)
      return true;
    }

    /** Liga/desliga o pump do expressionManager do SDK (Fase B vs. Fase C). */
    setExpressionPump(on) {
      this._pumpExpressionManager = Boolean(on);
    }

    /**
     * Define uma pose emocional suave (ease-in → hold → ease-out por frame).
     * Para modelos sem expressões exp3 (Hiyori): segura a emoção no rosto/corpo
     * de forma fluida, em vez de só um gesto rápido. `neutral`/`""` solta a pose.
     */
    setEmotionPose(emotion, holdMs = 5000) {
      const pose = EMOTION_POSES[emotion];
      if (pose === undefined) return; // emoção desconhecida → não mexe na pose
      const now = performance.now();
      // Dedup: a MESMA emoção re-assertada com hold ativo só renova o hold —
      // sem flip de _tiltSide, sem rebuild do alvo. Era a guinada do "pensar":
      // o think chega 2× por turno (pré-evento do humor + marker [think]) e
      // cada chamada virava o lado → o alvo balançava -8°→+8° no meio do hold.
      if (this._poseEmotion === emotion && this._poseTarget && now < this._poseHoldUntil) {
        this._poseHoldUntil = now + Math.max(0, holdMs);
        return;
      }
      let target = pose;
      if (pose.alternate) {
        // Tilt pensativo: alterna o lado a cada ativação fresca (headZ/bodyZ).
        this._tiltSide = -(this._tiltSide || 1);
        target = {
          ...pose,
          headZ: (pose.headZ || 0) * this._tiltSide,
          bodyZ: (pose.bodyZ || 0) * this._tiltSide,
        };
      }
      this._poseEmotion = emotion;
      this._poseTarget = target; // {} (neutral) → relaxa tudo para 0
      this._poseHoldUntil = now + Math.max(0, holdMs);
    }

    // Suaviza os parâmetros da pose em direção ao alvo todo frame, com constante
    // de tempo POR EMOÇÃO (pose.tau) — independente do FPS. Relaxar usa
    // POSE_RELAX_TAU (mais lento, retorno orgânico ao neutro).
    _updateEmotionPose(coreModel, dt, ctx) {
      const cur = this._poseCur || (this._poseCur = {});
      const active = this._poseTarget && performance.now() < this._poseHoldUntil;
      const target = active ? this._poseTarget : null;
      // Nada ativo e nada a relaxar → não escreve (devolve controle à motion).
      if (!target && !this._poseDecaying) return;

      const tau = target ? (target.tau || 0.12) : POSE_RELAX_TAU;
      const k = 1 - Math.exp(-dt / tau);
      let anyNonZero = false;

      // Gesto/motion controla olhos e boca — não competir (blink snap nos olhos).
      if (ctx && !ctx.isIdleMotion) {
        if (!target && !this._poseDecaying) return;
        for (const key of POSE_FACE_KEYS) {
          const next = (cur[key] || 0) * (1 - k);
          cur[key] = Math.abs(next) > 0.002 ? next : 0;
          if (Math.abs(cur[key]) > 0.002) anyNonZero = true;
        }
        for (const key of POSE_ADD_KEYS) {
          const next = (cur[key] || 0) * (1 - k);
          cur[key] = Math.abs(next) > 0.01 ? next : 0;
          if (Math.abs(cur[key]) > 0.01) anyNonZero = true;
        }
        this._poseDecaying = !target && anyNonZero;
        if (!active && !anyNonZero) {
          this._poseTarget = null;
          this._poseEmotion = null; // relaxou → próximo re-fire é ativação fresca
        }
        return;
      }

      // Quando phonemeEnabled, o PhonemeLipSync é quem controla mouthForm/cheek
      // → emoção só controla os params que o phoneme não mexe (olhos/sorriso).
      const skipFaceKeys = this.phonemeEnabled;
      const faceKeysToSkip = skipFaceKeys
        ? new Set(["mouthForm", "cheek"])
        : new Set();
      const skipEyeSmile = this.speaking;

      for (const key of POSE_FACE_KEYS) {
        if (skipFaceKeys && faceKeysToSkip.has(key)) continue;
        if (skipEyeSmile && (key === "eyeLSmile" || key === "eyeRSmile")) continue;
        const tgt = target ? (target[key] || 0) : 0;
        const next = (cur[key] || 0) + (tgt - (cur[key] || 0)) * k;
        cur[key] = next;
        if (Math.abs(next) > 0.002) anyNonZero = true;
        this._setParam(coreModel, this.params[key], next);
      }
      const allowBodyPose = !ctx || ctx.isIdleMotion;
      // Beat ativo = dono da cabeça: o tilt da pose cede (alvo 0, blend mais
      // rápido) para não somar com o balanço do beat; o rosto continua na pose.
      const kAdd = this._beatActive ? 1 - Math.exp(-dt / 0.15) : k;
      for (const key of POSE_ADD_KEYS) {
        const tgt = (target && !this._beatActive) ? (target[key] || 0) : 0;
        const next = (cur[key] || 0) + (tgt - (cur[key] || 0)) * kAdd;
        cur[key] = next;
        if (Math.abs(next) > 0.01) anyNonZero = true;
        if (!allowBodyPose) continue;
        const pid = key === "headZ" ? this.params.angleZ : this.params.bodyAngleZ;
        this._addParam(coreModel, pid, next);
      }

      // Após o hold, segue relaxando para 0; quando assenta, para de escrever.
      this._poseDecaying = !target && anyNonZero;
      if (!active && !anyNonZero) {
        this._poseTarget = null;
        this._poseEmotion = null; // relaxou → próximo re-fire é ativação fresca
      }
    }

    /** Registra uma função `(coreModel, t, dt)` rodada todo frame. */
    registerFrameHook(fn) {
      if (typeof fn === "function") this._frameHooks.push(fn);
      return () => {
        const i = this._frameHooks.indexOf(fn);
        if (i >= 0) this._frameHooks.splice(i, 1);
      };
    }

    /** Remove o hook e restaura o update original do SDK. */
    dispose() {
      if (this._installed && this.motionManager && this._origUpdate) {
        this.motionManager.update = this._origUpdate;
      }
      if (this.motionManager?.off && this._onMotionFinish) {
        try { this.motionManager.off("motionFinish", this._onMotionFinish); } catch (_) {}
      }
      if (this.eyeBlink && this._origEyeBlinkUpdate) {
        this.eyeBlink.update = this._origEyeBlinkUpdate;
        this._origEyeBlinkUpdate = null;
      }
      if (this.eyeBlink && this._origEyeBlinkUpdateParams) {
        this.eyeBlink.updateParameters = this._origEyeBlinkUpdateParams;
        this._origEyeBlinkUpdateParams = null;
      }
      this._installed = false;
    }

    // ----------------------------------------------------------------
    // Loop por frame
    // ----------------------------------------------------------------
    _runPostPlugins(coreModel, ctx) {
      // Suaviza o salto dos gestos LOGO após o update do SDK (antes de foco/
      // ênfase/beat, que entram aditivos depois).
      this._updateMotionSmoothing(coreModel, ctx.dt, ctx);
      // Idle focus da Airi só altera alvo quando não há gesture motion cuidando
      // do corpo. Cursor ativo continua permitido por ser uma fonte explícita.
      this._updateFocus(coreModel, ctx.now, ctx.dt, ctx);
      // Beat DEPOIS do update do SDK e do smoothing (ver _updateBeatSync: no
      // estágio pre o add era comido pelo fadeWeight das curvas e ACUMULAVA
      // nos gaps de motion via save/loadParameters — guinadas violentas).
      this._updateBeatSync(coreModel, ctx);
    }

    // Mola criticamente amortecida que segue o valor cru da motion como ALVO,
    // suavizando os saltos dos gestos do Hiyori (porte do semi-implicit Euler do
    // useMotionUpdatePluginBeatSync da Airi, com sub-passos fixos p/ estabilidade
    // independente do FPS).
    //
    // O ponto-chave das transições: gestos do Hiyori têm FadeOut=0, então quando o
    // gesto ACABA o SDK larga o parâmetro de uma vez (salta da pose do gesto p/ a
    // idle). Por isso a mola NÃO pode parar só porque `isIdleMotion` virou true —
    // ela precisa continuar assentando do pose do gesto até o valor idle. Regra:
    //   - gesto ativo  → sempre suaviza (entra no gesto sem tranco);
    //   - idle, mas ainda longe do alvo → continua suavizando (sai do gesto sem
    //     tranco — este é o flip que faltava);
    //   - idle e já assentado → solta o controle (não escreve), devolvendo o
    //     parâmetro à motion idle e evitando feedback com a ênfase aditiva.
    _updateMotionSmoothing(coreModel, dt, ctx) {
      const states = this._smoothState;
      if (!states || !states.length || dt <= 0) return;

      const current = this.motionManager?.state?.currentGroup ?? null;
      // Sem motion ativa (gap gesto→idle) ≠ gesto — evita mola prender o corpo.
      const gesture = Boolean(current) && !ctx.isIdleMotion;
      const stiffness = this.SMOOTH_STIFFNESS;
      const damping = this.SMOOTH_DAMPING;
      const STEP = 1 / 120; // sub-passo fixo

      if (ctx.isIdleMotion && !gesture) {
        if (this._limitedMotionModel) {
          // Limitado (Mao): mola só na janela pós-gesto (~1,6s). Fora disso o SDK é
          // dono do corpo (mtn_01 balanço); mola contínua anulava as curvas idle.
          if (performance.now() >= this._postGestureSettleUntil) {
            this._resetSmoothState();
            return;
          }
        } else {
          // Completo (Hiyori, c4): mola contínua em idle suaviza o wrap do loop
          // (idles sem fade). Só solta quando assentou (senão briga com a ênfase).
          let settling = false;
          for (const s of states) {
            let target;
            try { target = coreModel.getParameterValueById(s.id); } catch (_) { continue; }
            if (s.pos == null || !Number.isFinite(s.pos)) s.pos = target;
            if (Math.abs(target - s.pos) > 0.01 || Math.abs(s.vel) > 0.01) settling = true;
          }
          if (!settling) {
            this._resetSmoothState();
            return;
          }
        }
      }

      for (const s of states) {
        let target;
        try { target = coreModel.getParameterValueById(s.id); } catch (_) { continue; }
        if (s.pos == null || !Number.isFinite(s.pos)) s.pos = target;

        // Em idle já assentado: solta o controle p/ a motion idle (não escreve).
        if (!gesture && Math.abs(target - s.pos) < 0.01 && Math.abs(s.vel) < 0.01) {
          s.pos = target;
          s.vel = 0;
          continue;
        }

        let remaining = dt;
        while (remaining > 0) {
          const h = remaining < STEP ? remaining : STEP;
          const accel = stiffness * (target - s.pos) - damping * s.vel;
          s.vel += accel * h; // Euler semi-implícito: velocidade primeiro
          s.pos += s.vel * h;
          remaining -= h;
        }
        // Snap ao assentar (evita micro-jitter residual).
        if (Math.abs(target - s.pos) < 0.01 && Math.abs(s.vel) < 0.01) {
          s.pos = target;
          s.vel = 0;
        }
        try { coreModel.setParameterValueById(s.id, s.pos); } catch (_) {}
      }
    }

    _runFinalPlugins(coreModel, ctx) {
      // Expressões rodam como final plugins, depois da motion do SDK.
      if (this._pumpExpressionManager && this.expressionManager) {
        try { this.expressionManager.update(coreModel, ctx.now); } catch (_) {}
      }

      for (const hook of this._frameHooks) {
        try { hook(coreModel, ctx.now, ctx.dt); } catch (e) { console.warn("[Live2DMotionEngine] frame hook error:", e); }
      }

      this._updateBlink(coreModel, ctx);
      this._updateLipSync(coreModel, ctx.dt);
      if (ctx.isIdleMotion) this._updateFidgets(coreModel, ctx); // T2.3 — micro-gestos
      if (ctx.isIdleMotion) this._updateEmphasis(coreModel, ctx);
      this._updateEmotionPose(coreModel, ctx.dt, ctx);
      this._updateIdleFsm(coreModel, ctx); // T1.6 — por último (após blink/pose)
    }

    // Saccades idle + foco de cabeça, OU rastreio do cursor quando ativo.
    // Replica a estratégia de animation.ts: alimenta o focusController (que o
    // SDK aplica em ParamAngle*/EyeBall após este hook) e ainda interpola
    // ParamEyeBall* diretamente para o olhar "liderar" o movimento.
    _updateFocus(coreModel, t, dt, ctx) {
      const fc = this.internalModel?.focusController;
      const nowMs = performance.now();
      const cursorActive = this.eyeTrackingEnabled && this.cursorTarget && nowMs < this.cursorExpiresAt;
      const inGesture = !cursorActive && ctx && !ctx.isIdleMotion;

      // 1) Define o ALVO de foco (não o valor aplicado). A mola abaixo o persegue.
      if (cursorActive) {
        this._focusGoal[0] = this.cursorTarget[0];
        this._focusGoal[1] = this.cursorTarget[1];
      } else if (inGesture) {
        // Gesto: recentra em vez de CONGELAR. Antes (early return) o
        // focusController ficava preso no último saccade e o SDK continuava
        // SOMANDO focus.x×30° no ParamAngleX o gesto inteiro — preso num
        // saccade lateral, o gesto todo saía deslocado ("guinada" p/ o lado).
        this._focusGoal[0] = 0;
        this._focusGoal[1] = 0;
      } else if (this.idleAnimationEnabled) {
        // Idle: reagenda alvos aleatórios em intervalos naturais (saccade).
        // T1.6: no cochilo (nível 5) os olhos ficam parados; no tédio (nível 2) o
        // olhar perambula um pouco mais (alvos mais frequentes/largos). Nos níveis
        // 0/1 o comportamento é idêntico ao original (sem regressão).
        const fsmLevel = this.idleFsmEnabled ? this._idleLevel : 0;
        if (fsmLevel >= 5) {
          // cochilo: sem novos saccades (olhar repousa)
        } else if (t >= this.nextSaccadeAt || t < this.lastSaccadeAt) {
          const wanderY = (fsmLevel === 2 || fsmLevel === 3) ? 1.0 : 0.7;
          this._focusGoal = [randFloat(-1, 1), randFloat(-1, wanderY)];
          this.lastSaccadeAt = t;
          const intervalScale = (fsmLevel === 2 || fsmLevel === 3) ? 0.6 : 1;
          this.nextSaccadeAt = t + (randomSaccadeInterval() * intervalScale) / 1000;
        }
      } else {
        this._focusGoal[0] = 0;
        this._focusGoal[1] = 0;
      }

      // 2) Cabeça: mola criticamente amortecida persegue o alvo (sub-passo fixo p/
      //    estabilidade independente do FPS). Acelera do repouso e freia ao chegar
      //    → transição idle→cursor sem o "tranco" do lerp de coeficiente fixo. A
      //    velocidade é contínua entre saccade/cursor, então redireciona sem corte.
      if (dt > 0) {
        const STEP = 1 / 120;
        const k = this.FOCUS_STIFFNESS;
        const c = this.FOCUS_DAMPING;
        for (let axis = 0; axis < 2; axis++) {
          let pos = this.focusTarget[axis];
          let vel = this._focusVel[axis];
          const goal = this._focusGoal[axis];
          let remaining = dt;
          while (remaining > 0) {
            const h = remaining < STEP ? remaining : STEP;
            const accel = k * (goal - pos) - c * vel; // semi-implícito: vel 1º
            vel += accel * h;
            pos += vel * h;
            remaining -= h;
          }
          this.focusTarget[axis] = pos;
          this._focusVel[axis] = vel;
        }
      }

      // Modo pet: amplitude um pouco menor para não estourar a janelinha.
      // Beat ativo: o foco da CABEÇA cede ~metade (duck suavizado) para o beat
      // não somar com saccades largos; os OLHOS continuam em escala cheia.
      const duckGoal = this._beatActive ? 0.7 : 1;
      this._focusDuck += (duckGoal - this._focusDuck) * (dt > 0 ? 1 - Math.exp(-dt / 0.5) : 1);
      // T1.6 — tédio/brincadeira: a cabeça acompanha mais o olhar (perambular visível).
      const _fsmL = this.idleFsmEnabled ? this._idleLevel : 0;
      const _wanderBoost = (_fsmL === 2 || _fsmL === 3) ? 1.5 : 1;
      // Cochilando: a cabeça desacelera/encolhe junto com o swing (1 frame de lag, ok).
      const _sleepDamp = this.idleFsmEnabled ? this._idleSwayDamp : 1;
      const headScale = (this.petMode ? 0.42 : 0.5) * this.headMotionScale * this._moodHeadScale * this._focusDuck * _wanderBoost * _sleepDamp;
      if (fc) {
        fc.focus(this.focusTarget[0] * headScale, this.focusTarget[1] * headScale, false);
        fc.update?.(dt * 1000);
      }

      // 3) Olhos lideram a cabeça: perseguem o ALVO CRU (saccade balístico, rápido),
      //    não o valor suavizado da cabeça. exp independente de FPS (~0,3 a 60fps).
      //    Durante gestos NÃO escreve os olhos — as curvas do gesto são donas
      //    deles (a mola/fc acima só recentra o offset aditivo da cabeça).
      if (inGesture) return;
      const eyeK = dt > 0 ? 1 - Math.exp(-dt / this.FOCUS_EYE_TAU) : 1;
      this._lerpParam(coreModel, this.params.eyeBallX, this._focusGoal[0], eyeK);
      this._lerpParam(coreModel, this.params.eyeBallY, this._focusGoal[1], eyeK);
    }

    // Piscada procedural com easing. Em idle, este método é o DONO da abertura
    // dos olhos (as curvas idle foram removidas em _stripIdleMotionEyeCurves e
    // o eyeBlink do SDK foi neutralizado): entre piscadas escreve 1 (mesmo
    // contrato do SDK, que restaurava olhos pós-gesto); durante a piscada
    // escreve baseline × fator, com o baseline capturado no frame de início —
    // como expressões rodam ANTES no pipeline, olhos semicerrados por exp3 são
    // respeitados durante a piscada.
    _updateBlink(coreModel, ctx) {
      // T1.6: dormindo (teto de abertura baixo: sonolento/cochilo) NÃO pisca — evita
      // o flutter da piscada brigando com o teto do sono. O _updateIdleFsm (depois)
      // segura os olhos fechados; ao acordar, _idleEyeCap volta a >0.6 e a piscada
      // retoma. (cruza o limiar uma única vez por ser suavizado → sem toggling.)
      if (this.idleFsmEnabled && this._idleEyeCap < 0.6) return;
      const isIdle = !ctx || ctx.isIdleMotion;
      if (!this.autoBlinkEnabled) {
        if (isIdle) {
          this._setParam(coreModel, this.params.eyeLOpen, 1);
          this._setParam(coreModel, this.params.eyeROpen, 1);
        }
        return;
      }
      if (!isIdle) {
        // Gestos animam os olhos nas próprias curvas; cancela piscada em curso
        // e re-agenda para depois do gesto.
        this._blinkPhase = "wait";
        this._blinkNextAt = 0;
        return;
      }

      const now = performance.now();
      if (this._blinkPhase === "wait") {
        if (!this._blinkNextAt) {
          this._blinkNextAt = now + this.BLINK_MIN_DELAY_MS +
            Math.random() * (this.BLINK_MAX_DELAY_MS - this.BLINK_MIN_DELAY_MS);
        }
        if (now < this._blinkNextAt) {
          this._setParam(coreModel, this.params.eyeLOpen, 1);
          this._setParam(coreModel, this.params.eyeROpen, 1);
          return;
        }
        // Início da piscada: captura o baseline deixado pelas expressões.
        let baseL = 1;
        let baseR = 1;
        try { baseL = coreModel.getParameterValueById(this.params.eyeLOpen); } catch (_) {}
        try { baseR = coreModel.getParameterValueById(this.params.eyeROpen); } catch (_) {}
        this._blinkBaseL = clamp01(Number.isFinite(baseL) ? baseL : 1);
        this._blinkBaseR = clamp01(Number.isFinite(baseR) ? baseR : 1);
        if (Math.max(this._blinkBaseL, this._blinkBaseR) < 0.3) {
          // Olhos já (quase) fechados por expressão: pula esta piscada.
          this._blinkNextAt = 0;
          return;
        }
        this._blinkPhase = "closing";
        this._blinkPhaseStart = now;
        this._blinkOpenDuration = this.BLINK_MIN_OPEN_MS +
          Math.random() * (this.BLINK_MAX_OPEN_MS - this.BLINK_MIN_OPEN_MS);
      }

      let factor = 1;
      if (this._blinkPhase === "closing") {
        const t = Math.min(1, (now - this._blinkPhaseStart) / this.BLINK_CLOSE_MS);
        factor = (1 - t) * (1 - t); // 1 - easeOutQuad(t): rápido no início
        if (t >= 1) {
          this._blinkPhase = "opening";
          this._blinkPhaseStart = now;
          factor = 0;
        }
      } else if (this._blinkPhase === "opening") {
        const t = Math.min(1, (now - this._blinkPhaseStart) / this._blinkOpenDuration);
        factor = t * t; // easeInQuad: lento no início, acelera
        if (t >= 1) {
          this._blinkPhase = "wait";
          this._blinkNextAt = 0;
          factor = 1;
        }
      }

      this._setParam(coreModel, this.params.eyeLOpen, this._blinkBaseL * factor);
      this._setParam(coreModel, this.params.eyeROpen, this._blinkBaseR * factor);
    }

    // Escreve a abertura da boca no param resolvido E no ParamA (vogal), para
    // modelos vowel-rigged (Vivian). No-op nos params ausentes.
    _setMouthOpen(coreModel, value) {
      if (this.params.mouth) this._setParam(coreModel, this.params.mouth, value);
      if (this.params.mouthVowel) this._setParam(coreModel, this.params.mouthVowel, value);
    }

    // Lip sync com attack/decay + cauda de release suave (smoothstep).
    // Quando phonemeEnabled, o mouthForm e cheek vêm do PhonemeLipSync e são
    // aplicados aqui junto com o amplitude-based mouthOpen.
    _updateLipSync(coreModel, dt) {
      const id = this.params.mouth;
      const mouthFormId = this.params.mouthForm;
      const cheekId = this.params.cheek;

      // Suavização de phoneme targets (form e cheek usam time constant ~0.08s)
      const formK = 1 - Math.exp(-dt / 0.08);
      const cheekK = 1 - Math.exp(-dt / 0.1);

      // Webcam ativa: a câmera dirige forma + abertura da boca diretamente,
      // ignorando phonemeEnabled e o nível de áudio (lip sync por webcam).
      if (performance.now() < this._faceUntil) {
        const ft = this._faceTarget;
        this._phonemeForm += (ft.mouthForm - this._phonemeForm) * formK;
        this._phonemeCheek += (ft.cheek - this._phonemeCheek) * cheekK;
        if (mouthFormId) this._setParam(coreModel, mouthFormId, this._phonemeForm);
        if (cheekId && Math.abs(this._phonemeCheek) > 0.005) {
          this._setParam(coreModel, cheekId, this._phonemeCheek);
        }
        if (id) {
          const target = clamp(ft.mouthOpen, 0, 1);
          const mouthTau = target > this.mouthValue ? 0.04 : 0.12;
          const rate = 1 - Math.exp(-dt / mouthTau);
          this.mouthValue = clamp(this.mouthValue + (target - this.mouthValue) * rate, 0, 1);
          this._setMouthOpen(coreModel, this.mouthValue);
        }
        return;
      }

      if (this.phonemeEnabled) {
        const pt = this._phonemeTarget;
        this._phonemeForm = this._phonemeForm + (pt.mouthForm - this._phonemeForm) * formK;
        this._phonemeCheek = this._phonemeCheek + (pt.cheek - this._phonemeCheek) * cheekK;
      } else {
        // Relaxa para 0 quando phoneme está desligado
        const relaxK = 1 - Math.exp(-dt / 0.15);
        this._phonemeForm = this._phonemeForm + (0 - this._phonemeForm) * relaxK;
        this._phonemeCheek = this._phonemeCheek + (0 - this._phonemeCheek) * relaxK;
      }

      // Aplica mouthForm (forma da boca) e cheek se existirem e se diferenciarem de 0
      if (mouthFormId && Math.abs(this._phonemeForm) > 0.005) {
        this._setParam(coreModel, mouthFormId, this._phonemeForm);
      }
      if (cheekId && Math.abs(this._phonemeCheek) > 0.005) {
        this._setParam(coreModel, cheekId, this._phonemeCheek);
      }

      // Amplitude-based mouth open (continua igual, agora com modifier do phoneme)
      if (!id) return;

      if (this.speaking) {
        let target = this.audioLevel;
        if (this.phonemeEnabled) {
          target = target * (this._phonemeTarget.mouthOpen ?? 1);
        }
        target = clamp01(target);
        // Attack/release em tempo real (não por frame): a 120Hz o lerp fixo
        // 0.5/0.25 dobrava a velocidade da boca. tau 40ms abre / 120ms fecha
        // ≈ mesmo envelope percebido que o antigo 0.5/0.25 a 60fps.
        const mouthTau = target > this.mouthValue ? 0.04 : 0.12;
        const rate = 1 - Math.exp(-dt / mouthTau);
        this.mouthValue = clamp01(this.mouthValue + (target - this.mouthValue) * rate);
        this._setMouthOpen(coreModel, this.mouthValue);
        this.lastForcedMouth = this.mouthValue;
        this.releaseRemainingMs = this.RELEASE_DURATION_MS;
        return;
      }

      // Em repouso (sem fala): durante um GESTO ativo a própria motion é dona da
      // boca — as tap motions de fábrica (Hiyori/Natori/Mao/Haru/Aniya) animam a
      // boca por curvas próprias, então NÃO sobrescrevemos. Sem gesto (idle/nada),
      // fecha suavemente no 0 — evita travar aberta em modelos cujo idle não toca a
      // boca (JaneDoe, Vivian).
      const gesture = Boolean(this.motionManager?.state?.currentGroup) && !this._isIdleMotion();
      if (gesture) {
        this.releaseRemainingMs = 0;
        return; // a motion controla a boca; não competir
      }
      if (this.releaseRemainingMs > 0) {
        this.releaseRemainingMs = Math.max(0, this.releaseRemainingMs - dt * 1000);
        const blend = smoothstep(1 - this.releaseRemainingMs / this.RELEASE_DURATION_MS);
        this.mouthValue = this.lastForcedMouth * (1 - blend);
      } else {
        this.mouthValue = 0;
      }
      this._setMouthOpen(coreModel, this.mouthValue);
    }

    // Sway de fala (porte do _updateSpeechMotion do vrm-renderer): envelope de
    // energia suavizado × duas senoides dessincronizadas ≈ ruído suave. Os
    // antigos impulsos de velocidade em direção aleatória (a cada 180ms, mola
    // subamortecida 90/11) eram trepidação por construção — quem fala balança
    // a cabeça continuamente, não aos trancos.
    _updateFidgets(coreModel, ctx) {
      // T2.3 — micro-gestos de postura no idle ACORDADO: um leve "ajeitar-se" (weight
      // shift + micro-inclinação) que tira a rigidez de ficar 100% parada. CAUTELA Live2D:
      // amplitude minúscula (~±1°), períodos longos e defasados (não-repetitivo), e
      // GATING forte — só em idle motion, NUNCA em fala/beat (donos do corpo) nem no sono
      // (lvl>=3, onde a FSM amortece o corpo). Reusa _addParam; sem param/curve novo.
      if (!this.fidgetsEnabled) return;
      if (this.speaking || this._beatActive) return;
      if (this.idleFsmEnabled && (this._idleLevel || 0) >= 3) return;
      const t = performance.now();
      const shift = Math.sin(t / 7300) * 0.6 + Math.sin(t / 11900) * 0.3; // bodyAngleX ~±0.9°
      const tilt = Math.sin(t / 9100 + 1.7) * 0.4;                        // angleZ ~±0.4°
      this._addParam(coreModel, this.params.bodyAngleX, shift);
      this._addParam(coreModel, this.params.angleZ, tilt);
    }

    _updateEmphasis(coreModel, ctx) {
      const dt = ctx.dt;
      const k = 1 - Math.exp(-dt / 0.25); // envelope (mesmo tau do VRM)
      const target = (this.speaking && !this._beatActive) ? this.audioLevel : 0;
      this._speechEnergy += (target - this._speechEnergy) * k;
      if (this._speechEnergy < 0.02) {
        this._speechEnergy = Math.max(0, this._speechEnergy);
        return;
      }
      const e = Math.min(1, this._speechEnergy * 2.2);
      const t = ctx.now; // segundos contínuos do clock do engine
      // Par de senoides do VRM (11.3/7.1) + eixo secundário lento (5.3).
      const swayZ = Math.sin(t * 11.3) * 0.6 + Math.sin(t * 7.1) * 0.4;
      const swayX = Math.sin(t * 5.3);
      const ampZ = (this.petMode ? 0.9 : 1.2) * this.headMotionScale;
      const z = swayZ * e * ampZ;
      const x = swayX * e * ampZ * 0.4;
      this._addParam(coreModel, this.params.angleZ, z);
      this._addParam(coreModel, this.params.angleX, x);
      this._addParam(coreModel, this.params.bodyAngleZ, z * 0.4);
    }

    // Beat-sync: oscilador de fase contínuo. A posição é uma SENOIDE pura —
    // o mesmo tipo de curva do balanço de idle da Hiyori (medido nos
    // motion3.json: AngleZ ±13-30°, AngleX ±8-23°, Z-dominante, corpo menor e
    // defasado) — só que no tempo da música. Não existem alvos nem molas: a
    // fase avança todo frame e os beats só modulam envelope/tempo/fase POR
    // TAXA, então a derivada é contínua por construção (zero "tremiliques").
    //
    // Roda no estágio POST (depois do update do SDK), gateado por estado:
    //  - idle tocando → ADD sobre as curvas (elas reescrevem todo frame, então
    //    o add cai exatamente 1× com ganho 1 — sem o bombeamento do fadeWeight
    //    que existia no estágio pre, nem acumulação via save/loadParameters);
    //  - idle DESLIGADO e sem motion → SET absoluto (nada reescreve os params,
    //    um add acumularia frame a frame até pinar em ±30°);
    //  - gesto ativo ou gap com idle ligado → não escreve (gesto é dono).
    _updateBeatSync(coreModel, ctx) {
      const dt = clamp(ctx.dt, 0, 0.05);
      const now = performance.now();

      // Envelope: enquanto chegam beats, persegue a amplitude do último; sem
      // beats por BEAT_RELEASE_MS, decai até zero. Sobe rápido (~0.25s) e
      // desce devagar (~1.2s) — entrada animada, saída orgânica.
      const sinceBeat = this.lastBeatAt ? now - this.lastBeatAt : Infinity;
      const ampGoal = sinceBeat <= this.BEAT_RELEASE_MS ? this._beatAmpTarget : 0;
      const ampTau = ampGoal > this._beatAmp ? 0.25 : 0.8;
      if (dt > 0) this._beatAmp += (ampGoal - this._beatAmp) * (1 - Math.exp(-dt / ampTau));

      if (this._beatAmp < 0.04) {
        this._beatAmp = ampGoal > 0 ? this._beatAmp : 0;
        this._beatActive = false;
        return;
      }
      this._beatActive = true;

      // Fase: avanço LIVRE e constante no tempo da música (período via EMA dos
      // intervalos). Nenhuma correção por beat toca a fase — ver _scheduleBeat.
      const rate = (Math.PI * 2) / this._beatPeriod;
      if (dt > 0) {
        this._beatPhase += dt * rate;
        if (this._beatPhase > Math.PI * 4) this._beatPhase -= Math.PI * 2;
      }

      // Curvas estilo idle: tilt (Z) dominante, giro (X) menor, corpo menor e
      // mais atrasado — as defasagens desenham arcos, não um pêndulo seco.
      const scale = this.headMotionScale * this._beatAmp;
      const x = Math.sin(this._beatPhase) * BEAT_SWAY_X * scale;
      const z = Math.sin(this._beatPhase - BEAT_PHASE_LAG_Z) * BEAT_SWAY_Z * scale;
      const bx = Math.sin(this._beatPhase - BEAT_PHASE_LAG_BODY) * BEAT_SWAY_BODY_X * scale;
      const bz = Math.sin(this._beatPhase - BEAT_PHASE_LAG_BODY - 0.3) * BEAT_SWAY_BODY_Z * scale;
      if (ctx.isIdleMotion) {
        this._addParam(coreModel, this.params.angleX, x);
        this._addParam(coreModel, this.params.angleZ, z);
        this._addParam(coreModel, this.params.bodyAngleX, bx);
        this._addParam(coreModel, this.params.bodyAngleZ, bz);
      } else if (!this.idleAnimationEnabled && !this.motionManager?.state?.currentGroup) {
        this._setParam(coreModel, this.params.angleX, x);
        this._setParam(coreModel, this.params.angleZ, z);
        this._setParam(coreModel, this.params.bodyAngleX, bx);
        this._setParam(coreModel, this.params.bodyAngleZ, bz);
      }
      // Gesto ativo ou gap de motion com idle ligado: não escreve.
    }

    // T1.6 — FSM de idle escalonado. Roda por ÚLTIMO em _runFinalPlugins p/ ter a
    // última palavra sobre a abertura dos olhos (depois do blink) e somar o
    // afundamento de cabeça. Só escreve params DENTRO do idle; recupera na hora.
    _updateIdleFsm(coreModel, ctx) {
      if (!this.idleFsmEnabled) return;
      const nowMs = performance.now();
      const cursorActive = this.cursorTarget && nowMs < this.cursorExpiresAt;
      // "Interagindo" = fala, cursor ativo, ou um GESTO não-idle de fato tocando.
      // O GAP entre loops de idle (currentGroup vazio → _isIdleMotion()=false) NÃO
      // conta como interação: senão o relógio zerava a cada ciclo de motion (~2-6s)
      // e a Hina NUNCA chegava ao sono (60-90s). Era esse o bug.
      const cg = this.motionManager?.state?.currentGroup;
      const realGesture = Boolean(cg) && !this._isIdleGroupName(cg);
      const interacting = this.speaking || cursorActive || realGesture;
      if (interacting) this._idleSince = nowMs;
      const el = (nowMs - this._idleSince) / 1000; // segundos de silêncio contínuo
      // Limiares (s): presente<8, relaxado<20, tédio<40, brincadeira<60, sonolento<90,
      // cochilo≥90. Cabem dentro da janela de IDLE_TIMEOUT_S=120 do backend (o
      // comentário idle "acorda" a Hina ~120s, depois a escalada recomeça).
      const level = el < 8 ? 0 : el < 20 ? 1 : el < 40 ? 2 : el < 60 ? 3 : el < 90 ? 4 : 5;
      if (idleDebugOn()) {
        try { this._dbgFrameMonitor(coreModel, level); } catch (_) {}
      }
      if (level !== this._idleLevel) {
        const wasDeepSleep = this._idleLevel >= 5;
        this._idleLevel = level;
        if (level <= 2) this._idlePlayNextAt = 0;
        // Ao ACORDAR do cochilo (lv5 → abaixo), reinicia o idle motion que o sono
        // profundo parou — o swing volta ao normal (respeita o toggle "Idle").
        if (wasDeepSleep && level < 5 && this.idleAnimationEnabled) {
          this._restartIdleMotion();
        }
        try {
          this.onIdleStateChange?.(level, ["presente", "relaxado", "tedio", "brincadeira", "sonolento", "cochilo"][level]);
        } catch (_) {}
      }
      // Alvos por nível + suavização exponencial (independente de FPS).
      const eyeCapTgt = level >= 5 ? 0.05 : level >= 4 ? 0.55 : level >= 3 ? 0.8 : 1;
      const droopTgt = level >= 5 ? -0.5 : level >= 4 ? -0.25 : level >= 2 ? -0.06 : 0;
      // Abrir e fechar os olhos na MESMA velocidade (devagar, ~0,8s) — sem snap.
      const k = ctx.dt > 0 ? 1 - Math.exp(-ctx.dt / 0.8) : 1;
      this._idleEyeCap += (eyeCapTgt - this._idleEyeCap) * k;
      this._idleDroopY += (droopTgt - this._idleDroopY) * k;
      // "Swing" do idle (sway de cabeça/corpo) encolhe ao cochilar até um leve
      // movimento (~0,15) no sono; volta a 1 ao acordar.
      // pAZ = rAZ(±30°) × swD (PROVADO no log). O swD É a amplitude do balanço da
      // cabeça no sono: 0.04→±1.2°, 0.06→±1.8°, 0.08→±2.4° — gentil, sem "flick".
      const swayTgt = level >= 5 ? 0.04 : level >= 4 ? 0.06 : level >= 3 ? 0.08 : 1;
      this._idleSwayDamp += (swayTgt - this._idleSwayDamp) * k;
      // DEBUG (só com __HINA_IDLE_DEBUG): jumps + string de HUD/heartbeat.
      if (idleDebugOn()) {
        const _snap = this._dbgSnap || {}, _prev = this._dbgSnapPrev || {};
        let _jmp = "";
        for (const _id in _snap) {
          const _d = _snap[_id] - (_prev[_id] ?? _snap[_id]);
          if (_prev[_id] !== undefined && Math.abs(_d) > 0.12) _jmp += _id.replace("Param", "") + (_d > 0 ? "+" : "") + _d.toFixed(2) + " ";
        }
        this._dbgSnapPrev = _snap;
        if (level >= 3 && _jmp) { this._dbgJumps = (this._dbgJumps || 0) + 1; this._dbgLastJump = "L" + level + " " + _jmp; }
        if (this._blinkPhase === "closing" && this._dbgPrevBlinkPhase !== "closing") this._dbgBlinks = (this._dbgBlinks || 0) + 1;
        this._dbgPrevBlinkPhase = this._blinkPhase;
        const _f = (id) => (_snap[id] ?? 0).toFixed(2);
        this._dbg = "b" + this.buildTag + " lvl:" + level
          + " ELO:" + _f("ParamEyeLOpen") + " EBX:" + _f("ParamEyeBallX") + " EBY:" + _f("ParamEyeBallY")
          + " ELS:" + _f("ParamEyeLSmile") + " BrY:" + _f("ParamBrowLY") + " BrF:" + _f("ParamBrowLForm")
          + " AZ:" + _f("ParamAngleZ") + " rAZ:" + (this._dbgRawAZ ?? 0).toFixed(1) + " pAZ:" + (this._dbgPostAZ ?? 0).toFixed(1) + " swD:" + (this._dbgSwD ?? 1).toFixed(2)
          + " jN:" + (this._dbgJumps || 0) + " LAST[" + (this._dbgLastJump || "-") + "] int:" + (interacting ? 1 : 0);
      }
      // Brincadeira solitária (nível 3): dispara um gesto leve esporádico.
      if (!interacting && level === 3 && this.onIdlePlay) {
        if (this._idlePlayNextAt === 0) this._idlePlayNextAt = nowMs + 8000 + Math.random() * 9000;
        else if (nowMs >= this._idlePlayNextAt) {
          this._idlePlayNextAt = nowMs + 12000 + Math.random() * 12000;
          try { this.onIdlePlay(); } catch (_) {}
        }
      }
      // CABEÇA/CORPO no sono: escala TODO o sway da motion idle (angleX/Y/Z + body).
      if (idleDebugOn()) {
        this._dbgSwD = this._idleSwayDamp;
        this._dbgRawAZ = this._safeGetParam(coreModel, this.params.angleZ, 999);
      }
      if (this._idleSwayDamp < 0.98) {
        for (const id of [this.params.angleZ, this.params.bodyAngleX, this.params.bodyAngleZ]) {
          const v = this._safeGetParam(coreModel, id, 0);
          if (v) this._setParam(coreModel, id, v * this._idleSwayDamp);
        }
      }
      if (idleDebugOn()) {
        this._dbgPostAZ = this._safeGetParam(coreModel, this.params.angleZ, 999);
      }
      // Afundamento (droop): offset estável p/ baixo, aplicado DEPOIS do damp (não escala).
      if (this._idleDroopY < -0.005) {
        this._addParam(coreModel, this.params.angleY, this._idleDroopY * 12); // graus p/ baixo
        this._lerpParam(coreModel, this.params.eyeBallY, this._idleDroopY, k);
      }
      // Teto de abertura do olho (sono): só REDUZ (respeita piscadas/expressões).
      if (this._idleEyeCap < 0.99) {
        const curL = this._safeGetParam(coreModel, this.params.eyeLOpen, 1);
        const curR = this._safeGetParam(coreModel, this.params.eyeROpen, 1);
        this._setParam(coreModel, this.params.eyeLOpen, Math.min(this._idleEyeCap, curL));
        this._setParam(coreModel, this.params.eyeROpen, Math.min(this._idleEyeCap, curR));
      }
    }

    // ===== MONITOR DE FRAMES (debug, modo web/console) =====
    // Captura TODOS os params do modelo a cada frame; mantém ring de ~3s e, ao ENTRAR
    // no sonolento (lvl3→4), dumpa o "ANTES" (ring) + loga ~6s "DEPOIS" — no console E
    // em log.txt (1 POST). Mapeia todo movimento na transição. Só os params que MUDAM
    // por frame (>0.002) + 1 baseline completo. Roda 1x por carga (recarregue p/ nova).
    _dbgFrameMonitor(coreModel, level) {
      let ids = this._dbgAllIds;
      if (ids === undefined) {
        ids = null;
        try { if (Array.isArray(coreModel._parameterIds) && coreModel._parameterIds.length) ids = coreModel._parameterIds.slice(); } catch (_) {}
        if (!ids) { try { const n = coreModel.getParameterCount(); const a = []; for (let i = 0; i < n; i++) { const p = coreModel.getParameterId(i); a.push((p && p.getString) ? p.getString().s : ("p" + i)); } ids = a; } catch (_) { ids = []; } }
        this._dbgAllIds = ids;
        try { console.log("%c[Hina] monitor pronto: " + ids.length + " params. Deixe ociosa ~90s p/ entrar no sonolento.", "color:#6cf"); } catch (_) {}
      }
      if (!ids || !ids.length) return;
      const snap = {};
      for (let i = 0; i < ids.length; i++) { try { snap[ids[i]] = coreModel.getParameterValueById(ids[i]); } catch (_) {} }
      const now = performance.now();
      this._dbgRing = this._dbgRing || [];
      this._dbgRing.push({ t: now, lvl: level, snap });
      while (this._dbgRing.length && now - this._dbgRing[0].t > 3000) this._dbgRing.shift();
      if (level >= 4 && (this._dbgPrevMonLvl ?? 0) < 4 && !this._dbgCapDone) {
        this._dbgCapturing = true; this._dbgCapStart = now;
        this._dbgCap = ["=== CAPTURA SONOLENTO (ANTES ~3s + DEPOIS ~6s) build " + (this.buildTag || "?") + " ==="];
        let prev = null;
        for (const f of this._dbgRing) { this._dbgCap.push(this._dbgFmtFrame(f, prev)); prev = f.snap; }
        this._dbgCap.push(">>>>>> ENTROU SONOLENTO (lvl 4) <<<<<<");
        this._dbgCapPrev = prev;
        try { console.log("%c[Hina] >>> CAPTURA iniciada (entrou sonolento) <<<", "color:#fc0;font-weight:bold"); } catch (_) {}
      }
      this._dbgPrevMonLvl = level;
      if (this._dbgCapturing) {
        const line = this._dbgFmtFrame({ t: now, lvl: level, snap }, this._dbgCapPrev);
        this._dbgCapPrev = snap;
        this._dbgCap.push(line);
        try { console.log(line); } catch (_) {}
        if (now - this._dbgCapStart > 6000) {
          this._dbgCapturing = false; this._dbgCapDone = true;
          // NOTE: sem keepalive — keepalive limita corpo a 64KB e a captura passa disso ("Failed to fetch").
          // .catch evita "Uncaught (in promise)" pois try/catch não pega rejeição assíncrona.
          try { fetch("/debug/idle-log", { method: "POST", headers: { "Content-Type": "text/plain" }, body: this._dbgCap.join("\n") }).then((r) => { try { console.log("%c[Hina] POST captura -> HTTP " + r.status, "color:#0f0"); } catch (_) {} }).catch((e) => { try { console.warn("[Hina] POST captura falhou:", e && e.message); } catch (_) {} }); } catch (_) {}
          try { console.log("%c[Hina] CAPTURA COMPLETA — " + this._dbgCap.length + " linhas (enviando p/ log.txt)", "color:#0f0;font-weight:bold"); } catch (_) {}
        }
      }
    }

    _dbgFmtFrame(f, prevSnap) {
      const t = ((f.t - (this._dbgCapStart || f.t)) / 1000).toFixed(2);
      if (!prevSnap) {
        const all = [];
        for (const k in f.snap) all.push(k + ":" + f.snap[k].toFixed(3));
        return "t=" + t + " lvl" + f.lvl + " BASELINE | " + all.join(" ");
      }
      let ch = "";
      for (const k in f.snap) { const d = f.snap[k] - (prevSnap[k] ?? f.snap[k]); if (Math.abs(d) > 0.002) ch += k + ":" + f.snap[k].toFixed(3) + "(" + (d > 0 ? "+" : "") + d.toFixed(3) + ") "; }
      return "t=" + t + " lvl" + f.lvl + " | " + (ch || "(estavel)");
    }

    _safeGetParam(coreModel, id, fallback) {
      if (!id) return fallback;
      try { return coreModel.getParameterValueById(id); } catch (_) { return fallback; }
    }

    // ----------------------------------------------------------------
    // Param helpers (defensivos)
    // ----------------------------------------------------------------
    _setParam(coreModel, id, value) {
      if (!id) return;
      try { coreModel.setParameterValueById(id, value); } catch (_) {}
    }

    _addParam(coreModel, id, value) {
      if (!id || !value) return;
      try { coreModel.addParameterValueById(id, value); } catch (_) {}
    }

    _lerpParam(coreModel, id, target, t) {
      if (!id) return;
      try {
        const cur = coreModel.getParameterValueById(id);
        coreModel.setParameterValueById(id, lerp(cur, target, t));
      } catch (_) {}
    }
  }

  global.Live2DMotionEngine = Live2DMotionEngine;
  global.resolveLive2DMotionIndex = resolveLive2DMotionIndex;
  global.LIVE2D_GENTLE_MOTION_INDEX = GENTLE_MOTION_INDEX;
})(window);
