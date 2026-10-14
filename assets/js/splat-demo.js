const host = document.getElementById('splat-view');
const status = document.getElementById('splat-status');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let visible = false;
let started = false;
let renderLoop;

async function start() {
  try {
    const [THREE, {SparkRenderer, SplatMesh}, {OrbitControls}] = await Promise.all([
      import('three'), import('@sparkjsdev/spark'), import('../vendor/three/OrbitControls.js'),
    ]);
    const renderer = new THREE.WebGLRenderer({alpha:true, antialias:false});
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    host.append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, .05, 100);
    camera.position.set(0, 0, 3.3);
    const spark = new SparkRenderer({renderer});
    scene.add(spark);
    const butterfly = new SplatMesh({url:'assets/splats/butterfly.spz'});
    butterfly.quaternion.set(1, 0, 0, 0);
    scene.add(butterfly);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = .07;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.autoRotate = !motion.matches;
    controls.autoRotateSpeed = .65;
    controls.target.set(0, 0, 0);
    const button = document.getElementById('splat-rotate');
    const viewButtons = [...document.querySelectorAll('[data-splat-view]')];
    const views = {
      front: {position:[0,0,3.3], target:[0,0,0]},
      angle: {position:[2.1,.4,2.55], target:[0,0,0]},
      detail: {position:[.15,.12,1.8], target:[.15,.12,0]},
    };
    function showView(name, pause = true) {
      const view = views[name];
      camera.position.set(...view.position);
      controls.target.set(...view.target);
      if (pause) controls.autoRotate = false;
      controls.update();
      host.dataset.view = name;
      viewButtons.forEach(item => item.setAttribute('aria-pressed', String(item.dataset.splatView === name)));
      motionState();
    }
    viewButtons.forEach(item => item.addEventListener('click', () => showView(item.dataset.splatView)));
    controls.addEventListener('start', () => {
      viewButtons.forEach(item => item.setAttribute('aria-pressed', 'false'));
      host.dataset.view = 'custom';
    });
    function motionState() {
      button.textContent = controls.autoRotate ? 'Pausar rotação' : 'Girar cena';
      button.setAttribute('aria-pressed', String(!controls.autoRotate));
    }
    button.addEventListener('click', () => { controls.autoRotate = !controls.autoRotate; motionState(); });
    motion.addEventListener('change', () => { controls.autoRotate = !motion.matches; motionState(); });
    motionState();
    document.getElementById('splat-reset').addEventListener('click', () => {
      showView('front');
    });
    host.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const axis = new THREE.Vector3(...(event.key.includes('Left') || event.key.includes('Right') ? [0,1,0] : [1,0,0]));
      const angle = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? .12 : -.12;
      camera.position.applyAxisAngle(axis, angle);
      controls.autoRotate = false;
      motionState();
      controls.update();
    });
    function resize() {
      const {width,height} = host.getBoundingClientRect();
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(host);
    resize();
    let last = 0;
    let frames = 0;
    renderLoop = (time) => {
      if (!visible || document.hidden) { last = time; return; }
      const dt = Math.min(.05, (time - last) / 1000 || .016);
      if (time - last < 1000 / 30) return;
      last = time;
      controls.update(dt);
      renderer.render(scene, camera);
      if (++frames % 30 === 0) host.dataset.frames = String(frames);
    };
    renderer.setAnimationLoop(renderLoop);
    await butterfly.initialized;
    host.dataset.ready = 'true';
    host.dataset.format = 'spz';
    status.hidden = true;
  } catch (error) {
    host.dataset.ready = 'false';
    status.textContent = 'A cena 3D não carregou neste navegador. O projeto e a referência continuam disponíveis abaixo.';
    console.warn('[Splat preview]', error.message);
  }
}
const observer = new IntersectionObserver(([entry]) => {
  visible = entry.isIntersecting;
  if (visible && !started) { started = true; start(); }
}, {rootMargin:'100px'});
observer.observe(host);
