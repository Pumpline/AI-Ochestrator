// Projektkarte: die Souls eines Projekts als Ring um das Repo, die Pipeline als Bögen zwischen den Nachbarn,
// der Rückweg review → code als Brücke über die Mitte. Ein laufender Flow ist ein Lichtimpuls auf dem Bogen zum
// aktuellen Schritt, dazu eine Speiche vom arbeitenden Schritt zum Repo. Braucht THREE (r128, global) aus index.html.

const ORDER = ["plan", "code", "test", "review", "gate", "ship"];
const C = { idle: 0x2a2e37, edge: 0x1b2334, lit: 0x4b57dd, done: 0x22c55e, gate: 0xf59e0b, failed: 0xef4444, repo: 0x7e88a0, text: "#c9cfde", dim: "#646b77" };
const R = 3.4;                                   // Ringradius
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const angle = (i) => -Math.PI * 5 / 6 + i * (Math.PI / 3);   // plan hinten links, im Uhrzeigersinn bis ship vorne links

function label(text, sub = "") {
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.font = "600 34px 'Chakra Petch', sans-serif"; ctx.fillStyle = C.text; ctx.textAlign = "center"; ctx.fillText(text.toUpperCase(), 128, 40);
  if (sub) { ctx.font = "26px 'IBM Plex Mono', monospace"; ctx.fillStyle = C.dim; ctx.fillText(sub, 128, 78); }
  const tex = new THREE.CanvasTexture(canvas); tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.1, 0.8, 1);
  return sprite;
}

export function mountProjectMap(container) {
  if (typeof THREE === "undefined") { container.innerHTML = `<div class="empty">3D-Karte braucht WebGL und three.js.</div>`; return { update() {}, dispose() {} }; }

  class Arc extends THREE.Curve {                // Kreisbogen auf dem Ring von Winkel a0 nach a1
    constructor(a0, a1) { super(); this.a0 = a0; this.a1 = a1; }
    getPoint(t, target = new THREE.Vector3()) { const a = this.a0 + (this.a1 - this.a0) * t; return target.set(Math.cos(a) * R, 0, Math.sin(a) * R); }
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const world = new THREE.Group(); scene.add(world);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(3, 6, 5); scene.add(sun);

  // Knoten auf dem Ring
  const pos = {}, nodes = {}, labels = {};
  ORDER.forEach((name, i) => {
    const a = angle(i);
    pos[name] = new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R);
    const geo = name === "gate" ? new THREE.OctahedronGeometry(0.5) : new THREE.SphereGeometry(0.4, 24, 16);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: C.idle, emissive: C.idle, emissiveIntensity: 0.2, roughness: 0.55, metalness: 0.1 }));
    mesh.position.copy(pos[name]); world.add(mesh); nodes[name] = mesh;
    const l = label(name); l.position.set(pos[name].x, -0.8, pos[name].z); world.add(l); labels[name] = l;
  });

  // Repo in der Mitte
  const center = new THREE.Vector3(0, 0, 0);
  const repo = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.7), new THREE.MeshBasicMaterial({ color: C.repo, wireframe: true, transparent: true, opacity: 0.55 }));
  world.add(repo);
  const repoLabel = label("repo"); repoLabel.position.set(0, -0.75, 0); world.add(repoLabel);

  // Kanten: Bögen zwischen den Nachbarn, dazu die gestrichelte Brücke review → code
  const edges = {}, curves = {};
  for (let i = 0; i < ORDER.length - 1; i++) {
    const a = ORDER[i], b = ORDER[i + 1];
    const curve = new Arc(angle(i), angle(i + 1)); curves[`${a}>${b}`] = curve;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(16)), new THREE.LineBasicMaterial({ color: C.edge }));
    world.add(line); edges[`${a}>${b}`] = line;
  }
  const mid = pos.review.clone().add(pos.code).multiplyScalar(0.5).add(new THREE.Vector3(0, 2.4, 0));
  const loop = new THREE.QuadraticBezierCurve3(pos.review, mid, pos.code); curves["review>code"] = loop;
  const loopLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop.getPoints(32)), new THREE.LineDashedMaterial({ color: C.edge, dashSize: 0.22, gapSize: 0.16 }));
  loopLine.computeLineDistances(); world.add(loopLine); edges["review>code"] = loopLine;

  // Bewegliches: Impulse je laufendem Flow, Speichen vom arbeitenden Schritt zum Repo
  const pulseGeo = new THREE.SphereGeometry(0.11, 12, 12);
  let pulses = [], spokes = [];

  function paint(name, color, glow) {
    const m = nodes[name].material; m.color.setHex(color); m.emissive.setHex(color); m.emissiveIntensity = glow;
  }

  function update(flows) {
    const now = Date.now();
    const recent = (f) => now - (f.updatedAt ?? 0) < 30 * 60 * 1000;
    const counts = Object.fromEntries(ORDER.map((n) => [n, 0]));
    const state = Object.fromEntries(ORDER.map((n) => [n, "idle"]));
    let loopLit = false;
    for (const p of pulses) world.remove(p.mesh); pulses = [];
    for (const s of spokes) world.remove(s); spokes = [];

    for (const f of flows) {
      const step = f.currentStep && ORDER.includes(f.currentStep) ? f.currentStep : null;
      if (f.status === "running" && step) {
        counts[step]++; state[step] = "active";
        const i = ORDER.indexOf(step);
        const fromLoop = step === "code" && (f.state?.attempts?.code ?? 1) > 1;
        const key = fromLoop ? "review>code" : i > 0 ? `${ORDER[i - 1]}>${step}` : null;
        if (fromLoop) loopLit = true;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
        const mesh = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: C.lit }));
        world.add(mesh); pulses.push({ mesh, curve: key ? curves[key] : null, at: pos[step], t: Math.random(), speed: 0.3 + Math.random() * 0.15 });
        if (step !== "gate") {
          const spoke = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pos[step], center]), new THREE.LineBasicMaterial({ color: C.lit, transparent: true, opacity: 0.7 }));
          world.add(spoke); spokes.push(spoke);
        }
      } else if (f.status === "waiting" && f.wait?.kind === "gate") {
        counts.gate++; state.gate = "gate";
        for (const n of ["plan", "code", "test", "review"]) if (state[n] === "idle") state[n] = "done";
        const mesh = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: C.gate }));
        world.add(mesh); pulses.push({ mesh, curve: null, at: pos.gate, orbit: true, t: Math.random() });
      } else if ((f.status === "failed" || f.status === "blocked") && step && recent(f)) {
        if (state[step] === "idle") state[step] = "failed"; counts[step]++;
      }
    }
    for (const n of ORDER) {
      const color = state[n] === "active" ? C.lit : state[n] === "done" ? C.done : state[n] === "gate" ? C.gate : state[n] === "failed" ? C.failed : C.idle;
      paint(n, color, state[n] === "active" || state[n] === "gate" ? 0.9 : state[n] === "done" ? 0.45 : 0.2);
      world.remove(labels[n]); labels[n] = label(n, counts[n] ? `${counts[n]} ${counts[n] === 1 ? "Flow" : "Flows"}` : ""); labels[n].position.set(pos[n].x, -0.8, pos[n].z); world.add(labels[n]);
    }
    for (const [k, line] of Object.entries(edges)) {
      const b = k.split(">")[1];
      const lit = k === "review>code" ? loopLit : (state[b] === "active" || state[b] === "gate");
      line.material.color.setHex(lit ? C.lit : C.edge);
    }
  }

  // Bedienung: ziehen dreht, Rad zoomt; ohne Eingabe pendelt die Welt leicht
  let dragging = false, lastX = 0, lastY = 0, rotY = 0, rotX = 0.7, zoom = 15, idle = 0;
  const el = renderer.domElement;
  el.style.cursor = "grab";
  el.addEventListener("pointerdown", (e) => { dragging = true; idle = 0; lastX = e.clientX; lastY = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointerup", (e) => { dragging = false; el.releasePointerCapture(e.pointerId); el.style.cursor = "grab"; idle = 0; });
  el.addEventListener("pointermove", (e) => { if (!dragging) return; rotY += (e.clientX - lastX) * 0.006; rotX = Math.max(0.15, Math.min(1.3, rotX + (e.clientY - lastY) * 0.004)); lastX = e.clientX; lastY = e.clientY; });
  el.addEventListener("wheel", (e) => { e.preventDefault(); zoom = Math.max(9, Math.min(24, zoom + e.deltaY * 0.01)); }, { passive: false });

  function resize() { const w = container.clientWidth || 600, h = container.clientHeight || 360; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  let raf = 0; const clock = new THREE.Clock();
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!dragging) idle += dt;
    const sway = REDUCED ? 0 : Math.min(1, Math.max(0, idle - 2)) * Math.sin(clock.elapsedTime * 0.2) * 0.2;
    world.rotation.y = rotY + sway;
    camera.position.set(0, Math.sin(rotX) * zoom, Math.cos(rotX) * zoom); camera.lookAt(0, -0.35, 0);
    for (const p of pulses) {
      if (!REDUCED) p.t = (p.t + dt * (p.speed ?? 0.4)) % 1;
      if (p.orbit) { const a = p.t * Math.PI * 2; p.mesh.position.set(p.at.x + Math.cos(a) * 0.8, p.at.y + 0.1, p.at.z + Math.sin(a) * 0.8); }
      else if (p.curve) { p.mesh.position.copy(p.curve.getPoint(p.t)); }
      else { p.mesh.position.set(p.at.x, p.at.y + 0.75 + Math.sin(p.t * Math.PI * 2) * 0.08, p.at.z); }
    }
    renderer.render(scene, camera);
  }
  frame();

  return {
    update,
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); container.innerHTML = ""; },
  };
}
