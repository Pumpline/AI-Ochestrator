// Projektkarte: die Souls eines Projekts als Knoten in einer kleinen 3D-Welt, die Pipeline als Kanten,
// laufende Flows als Lichtimpulse auf der Kante zum aktuellen Schritt. Man sieht, welcher Zweig gerade arbeitet.
// Braucht THREE (r128, global) aus index.html.

const ORDER = ["plan", "code", "test", "review", "gate", "ship"];
const C = {
  idle: 0x2a2e37, edge: 0x1b2334, edgeLit: 0x4b57dd, active: 0x4b57dd, done: 0x22c55e, gate: 0xf59e0b, failed: 0xef4444, repo: 0x7e88a0, text: "#c9cfde", dim: "#646b77",
};
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

function label(text, sub = "") {
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.font = "600 34px 'Chakra Petch', sans-serif"; ctx.fillStyle = C.text; ctx.textAlign = "center"; ctx.fillText(text.toUpperCase(), 128, 40);
  if (sub) { ctx.font = "26px 'IBM Plex Mono', monospace"; ctx.fillStyle = C.dim; ctx.fillText(sub, 128, 78); }
  const tex = new THREE.CanvasTexture(canvas); tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.4, 0.9, 1);
  return sprite;
}

export function mountProjectMap(container) {
  if (typeof THREE === "undefined") { container.innerHTML = `<div class="empty">3D-Karte braucht WebGL und three.js.</div>`; return { update() {}, dispose() {} }; }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 4.2, 12.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const world = new THREE.Group(); scene.add(world);
  const grid = new THREE.GridHelper(20, 20, 0x131a2b, 0x0f141f); grid.position.y = -1.6; world.add(grid);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.PointLight(0x4b57dd, 1.2, 40); key.position.set(4, 8, 8); scene.add(key);

  // Knoten
  const pos = {}; const nodes = {}; const labels = {};
  ORDER.forEach((name, i) => {
    const x = (i - 2.5) * 2.3; const z = -Math.abs(i - 2.5) * 0.35;
    pos[name] = new THREE.Vector3(x, 0, z);
    const geo = name === "gate" ? new THREE.OctahedronGeometry(0.5) : new THREE.IcosahedronGeometry(0.45, 1);
    const core = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: C.idle, emissive: C.idle, emissiveIntensity: 0.25, roughness: 0.5, metalness: 0.2, transparent: true, opacity: 0.85 }));
    const wire = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: C.idle, wireframe: true, transparent: true, opacity: 0.35 }));
    wire.scale.setScalar(1.45);
    const g = new THREE.Group(); g.position.copy(pos[name]); g.add(core, wire); world.add(g);
    nodes[name] = { group: g, core, wire };
    const l = label(name); l.position.set(x, -1.05, z + 0.2); world.add(l); labels[name] = l;
  });
  // Repo unten in der Mitte, mit allen Arbeitsschritten verbunden
  const repoPos = new THREE.Vector3(0, -3.2, 0.6);
  const repo = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.9), new THREE.MeshBasicMaterial({ color: C.repo, wireframe: true, transparent: true, opacity: 0.5 }));
  repo.position.copy(repoPos); world.add(repo);
  const repoLabel = label("repo"); repoLabel.position.set(0, -4.0, 0.8); world.add(repoLabel);
  for (const n of ["plan", "code", "test", "review", "ship"]) {
    const g = new THREE.BufferGeometry().setFromPoints([pos[n], repoPos]);
    world.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.35 })));
  }

  // Kanten der Pipeline + die Rückkante review → code
  const edges = {}; const curves = {};
  for (let i = 0; i < ORDER.length - 1; i++) {
    const a = ORDER[i], b = ORDER[i + 1];
    const curve = new THREE.LineCurve3(pos[a], pos[b]); curves[`${a}>${b}`] = curve;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(2)), new THREE.LineBasicMaterial({ color: C.edge }));
    world.add(line); edges[`${a}>${b}`] = line;
  }
  const mid = pos.review.clone().add(pos.code).multiplyScalar(0.5).add(new THREE.Vector3(0, 2.2, -0.6));
  const loop = new THREE.QuadraticBezierCurve3(pos.review, mid, pos.code); curves["review>code"] = loop;
  const loopLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop.getPoints(32)), new THREE.LineDashedMaterial({ color: C.edge, dashSize: 0.25, gapSize: 0.18 }));
  loopLine.computeLineDistances(); world.add(loopLine); edges["review>code"] = loopLine;

  // Impulse: pro laufendem Flow ein Licht auf der Kante zum aktuellen Schritt
  const pulseGeo = new THREE.SphereGeometry(0.12, 12, 12);
  let pulses = [];

  function paint(name, color, glow = 0.25) {
    const n = nodes[name]; n.core.material.color.setHex(color); n.core.material.emissive.setHex(color); n.core.material.emissiveIntensity = glow; n.wire.material.color.setHex(color);
  }

  function update(flows) {
    const now = Date.now();
    const recent = (f) => now - (f.updatedAt ?? 0) < 30 * 60 * 1000;
    const counts = Object.fromEntries(ORDER.map((n) => [n, 0]));
    const state = Object.fromEntries(ORDER.map((n) => [n, "idle"]));
    let loopLit = false;
    for (const l of pulses) world.remove(l.mesh); pulses = [];

    for (const f of flows) {
      const step = f.currentStep && ORDER.includes(f.currentStep) ? f.currentStep : null;
      if (f.status === "running" && step) {
        counts[step]++; state[step] = "active";
        const i = ORDER.indexOf(step);
        const fromLoop = step === "code" && (f.state?.attempts?.code ?? 1) > 1;
        const key = fromLoop ? "review>code" : i > 0 ? `${ORDER[i - 1]}>${step}` : null;
        if (fromLoop) loopLit = true;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
        const mesh = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: C.active }));
        world.add(mesh); pulses.push({ mesh, curve: key ? curves[key] : null, at: pos[step], t: Math.random(), speed: 0.35 + Math.random() * 0.2 });
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
      const color = state[n] === "active" ? C.active : state[n] === "done" ? C.done : state[n] === "gate" ? C.gate : state[n] === "failed" ? C.failed : C.idle;
      paint(n, color, state[n] === "active" || state[n] === "gate" ? 0.9 : state[n] === "done" ? 0.45 : 0.2);
      world.remove(labels[n]); labels[n] = label(n, counts[n] ? `${counts[n]} ${counts[n] === 1 ? "Flow" : "Flows"}` : ""); labels[n].position.set(pos[n].x, -1.05, pos[n].z + 0.2); world.add(labels[n]);
    }
    for (const [k, line] of Object.entries(edges)) {
      const [a, b] = k.split(">");
      const lit = k === "review>code" ? loopLit : (state[b] === "active" || state[b] === "gate");
      line.material.color.setHex(lit ? C.edgeLit : C.edge); line.material.opacity = 1;
    }
  }

  // Bedienung: ziehen dreht (begrenzt, damit die Kette lesbar bleibt), Rad zoomt; ohne Eingabe pendelt die Welt leicht
  let dragging = false, lastX = 0, lastY = 0, rotY = 0, rotX = 0.22, zoom = 12.5, idle = 0;
  const el = renderer.domElement;
  el.style.cursor = "grab";
  el.addEventListener("pointerdown", (e) => { dragging = true; idle = 0; lastX = e.clientX; lastY = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointerup", (e) => { dragging = false; el.releasePointerCapture(e.pointerId); el.style.cursor = "grab"; idle = 0; });
  el.addEventListener("pointermove", (e) => { if (!dragging) return; rotY = Math.max(-1.1, Math.min(1.1, rotY + (e.clientX - lastX) * 0.006)); rotX = Math.max(-0.2, Math.min(1.1, rotX + (e.clientY - lastY) * 0.004)); lastX = e.clientX; lastY = e.clientY; });
  el.addEventListener("wheel", (e) => { e.preventDefault(); zoom = Math.max(6, Math.min(24, zoom + e.deltaY * 0.01)); }, { passive: false });

  function resize() { const w = container.clientWidth || 600, h = container.clientHeight || 380; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  let raf = 0; const clock = new THREE.Clock();
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!dragging) idle += dt;
    const sway = REDUCED ? 0 : Math.min(1, Math.max(0, idle - 2)) * Math.sin(clock.elapsedTime * 0.25) * 0.28;
    world.rotation.y = rotY + sway;
    camera.position.set(0, Math.sin(rotX) * zoom, Math.cos(rotX) * zoom); camera.lookAt(0, -0.6, 0);
    for (const p of pulses) {
      if (!REDUCED) p.t = (p.t + dt * (p.speed ?? 0.4)) % 1;
      if (p.orbit) { const a = p.t * Math.PI * 2; p.mesh.position.set(p.at.x + Math.cos(a) * 0.85, p.at.y + Math.sin(a * 2) * 0.15, p.at.z + Math.sin(a) * 0.85); }
      else if (p.curve) { p.mesh.position.copy(p.curve.getPoint(p.t)); }
      else { p.mesh.position.set(p.at.x, p.at.y + 0.8 + Math.sin(p.t * Math.PI * 2) * 0.1, p.at.z); }
    }
    for (const n of ORDER) { const s = 1 + Math.sin(clock.elapsedTime * 2 + ORDER.indexOf(n)) * 0.03; nodes[n].wire.scale.setScalar(1.45 * s); }
    renderer.render(scene, camera);
  }
  frame();

  return {
    update,
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); container.innerHTML = ""; },
  };
}
