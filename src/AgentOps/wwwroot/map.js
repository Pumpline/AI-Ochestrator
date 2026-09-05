// Projektkarte: die Souls eines Projekts als Ring um das Repo — als Spirale, jeder Schritt eine Stufe höher —,
// die Pipeline als Bögen zwischen den Nachbarn, der Rückweg review → code als Brücke über die Mitte.
// Ein laufender Flow ist ein Lichtimpuls auf dem Bogen zum aktuellen Schritt, dazu eine Speiche vom arbeitenden
// Schritt zum Repo. Mit einem Fokus-Flow steht auf jedem Bogen, wie lange der Schritt gebraucht hat und wie viele
// Tokens er gekostet hat. Klick auf einen Knoten → onSelect(step). Flach gezeichnet, ohne Licht und Schatten.
// Braucht THREE (r128, global) aus index.html.

const ORDER = ["plan", "code", "test", "review", "gate", "ship"];
const C = { idle: 0xb3bfcf, edge: 0xd3dce6, lit: 0x0d9488, done: 0x16a34a, gate: 0xd97706, failed: 0xdc2626, repo: 0x64748b, text: "#334155", dim: "#8b98a9" };
const R = 3.4;                                   // Ringradius
const RISE = 0.45;                               // Höhenstufe je Schritt — die Spirale
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const angle = (i) => -Math.PI * 5 / 6 + i * (Math.PI / 3);   // plan hinten links, im Uhrzeigersinn bis ship vorne links
const height = (i) => (i - 2.5) * RISE;

function sprite(lines, scale = 1) {
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 112;
  const ctx = canvas.getContext("2d"); ctx.textAlign = "center";
  let y = 40;
  for (const [text, font, color] of lines) { ctx.font = font; ctx.fillStyle = color; ctx.fillText(text, 160, y); y += 38; }
  const tex = new THREE.CanvasTexture(canvas); tex.minFilter = THREE.LinearFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.set(2.5 * scale, 0.875 * scale, 1);
  return s;
}
const nodeLabel = (name, sub = "") => sprite([[name.toUpperCase(), "600 34px 'Space Grotesk', sans-serif", C.text], ...(sub ? [[sub, "26px 'JetBrains Mono', monospace", C.dim]] : [])]);
const edgeLabel = (text) => sprite([[text, "600 30px 'JetBrains Mono', monospace", C.text]], 1);

export function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60); const r = s % 60;
  return m < 60 ? `${m} min ${r} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
export function fmtTokens(n) {
  if (n == null) return "";
  return n >= 1_000_000 ? `${(n / 1e6).toFixed(1).replace(".", ",")}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",")}k` : String(n);
}

export function mountProjectMap(container, { onSelect } = {}) {
  if (typeof THREE === "undefined") { container.innerHTML = `<div class="empty">3D-Karte braucht WebGL und three.js.</div>`; return { update() {}, dispose() {} }; }

  class Arc extends THREE.Curve {                // Bogen auf der Spirale von Knoten i nach j
    constructor(i, j) { super(); this.i = i; this.j = j; }
    getPoint(t, target = new THREE.Vector3()) {
      const a = angle(this.i) + (angle(this.j) - angle(this.i)) * t;
      return target.set(Math.cos(a) * R, height(this.i) + (height(this.j) - height(this.i)) * t, Math.sin(a) * R);
    }
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const world = new THREE.Group(); scene.add(world);

  // Knoten: flache Scheiben ohne Licht — nur Farbe trägt Bedeutung
  const pos = {}, nodes = {}, labels = {};
  ORDER.forEach((name, i) => {
    const a = angle(i);
    pos[name] = new THREE.Vector3(Math.cos(a) * R, height(i), Math.sin(a) * R);
    const geo = name === "gate" ? new THREE.OctahedronGeometry(0.46) : new THREE.SphereGeometry(0.36, 20, 14);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: C.idle }));
    mesh.position.copy(pos[name]); mesh.userData.step = name; world.add(mesh); nodes[name] = mesh;
    const l = nodeLabel(name); l.position.set(pos[name].x, pos[name].y - 0.95, pos[name].z); world.add(l); labels[name] = l;
  });

  // Repo in der Mitte, auf mittlerer Höhe
  const center = new THREE.Vector3(0, 0, 0);
  const repo = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.6), new THREE.MeshBasicMaterial({ color: C.repo, wireframe: true, transparent: true, opacity: 0.5 }));
  world.add(repo);
  const repoLabel = nodeLabel("repo"); repoLabel.position.set(0, -0.8, 0); world.add(repoLabel);

  // Kanten: Bögen zwischen den Nachbarn, dazu die gestrichelte Brücke review → code
  const edges = {}, curves = {};
  for (let i = 0; i < ORDER.length - 1; i++) {
    const key = `${ORDER[i]}>${ORDER[i + 1]}`;
    const curve = new Arc(i, i + 1); curves[key] = curve;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(16)), new THREE.LineBasicMaterial({ color: C.edge }));
    world.add(line); edges[key] = line;
  }
  const mid = pos.review.clone().add(pos.code).multiplyScalar(0.5).add(new THREE.Vector3(0, 2.2, 0));
  const loop = new THREE.QuadraticBezierCurve3(pos.review, mid, pos.code); curves["review>code"] = loop;
  const loopLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop.getPoints(32)), new THREE.LineDashedMaterial({ color: C.edge, dashSize: 0.22, gapSize: 0.16 }));
  loopLine.computeLineDistances(); world.add(loopLine); edges["review>code"] = loopLine;

  // Bewegliches: Impulse je laufendem Flow, Speichen zum Repo, Beschriftungen auf den Bögen
  const pulseGeo = new THREE.SphereGeometry(0.1, 12, 12);
  let pulses = [], spokes = [], edgeLabels = [];
  const paint = (name, color) => nodes[name].material.color.setHex(color);

  // Fokus: ein einzelner Lauf — Dauer und Tokens je Bogen. steps = [{ step, attempt, durationMs, tokens }], gate = { waitMs }
  function labelEdges(focus) {
    for (const l of edgeLabels) world.remove(l); edgeLabels = [];
    if (!focus) return;
    const byEdge = new Map();
    for (const s of focus.steps ?? []) {
      const i = ORDER.indexOf(s.step); if (i < 0) continue;
      const key = s.step === "code" && s.attempt > 1 ? "review>code" : i > 0 ? `${ORDER[i - 1]}>${s.step}` : "plan";
      byEdge.set(key, (byEdge.get(key) ?? []).concat([s]));
    }
    if (focus.gate?.waitMs != null) byEdge.set("review>gate", (byEdge.get("review>gate") ?? []).concat([{ durationMs: focus.gate.waitMs, tokens: null }]));
    for (const [key, items] of byEdge) {
      const ms = items.reduce((a, x) => a + (x.durationMs ?? 0), 0);
      const tok = items.some((x) => x.tokens != null) ? items.reduce((a, x) => a + (x.tokens ?? 0), 0) : null;
      const text = [items.length > 1 ? `${items.length}×` : "", fmtDuration(ms), tok != null ? `${fmtTokens(tok)} tok` : ""].filter(Boolean).join(" · ");
      if (!text) continue;
      const l = edgeLabel(text);
      // Beschriftung außerhalb des Rings, damit sie sich nicht mit Knoten und Brücke überlagert
      let p;
      if (key === "plan") p = pos.plan.clone().add(new THREE.Vector3(0, 0.75, 0));
      else if (key === "review>code") p = curves[key].getPoint(0.5).add(new THREE.Vector3(0, 0.9, 0));
      else { const m = curves[key].getPoint(0.5); p = new THREE.Vector3(m.x * 1.24, m.y + 0.12, m.z * 1.24); }
      l.position.copy(p); world.add(l); edgeLabels.push(l);
    }
  }

  function update(flows, focus = null) {
    const now = Date.now();
    const recent = (f) => now - (f.updatedAt ?? 0) < 30 * 60 * 1000;
    const counts = Object.fromEntries(ORDER.map((n) => [n, 0]));
    const state = Object.fromEntries(ORDER.map((n) => [n, "idle"]));
    let loopLit = false;
    for (const p of pulses) world.remove(p.mesh); pulses = [];
    for (const s of spokes) world.remove(s); spokes = [];

    for (const f of flows) {
      const step = f.currentStep && ORDER.includes(f.currentStep) ? f.currentStep : null;
      const i = step ? ORDER.indexOf(step) : -1;
      if (f.status === "running" && step) {
        counts[step]++; state[step] = "active";
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
      } else if ((f.status === "failed" || f.status === "blocked") && step && (recent(f) || focus)) {
        if (state[step] === "idle") state[step] = "failed"; counts[step]++;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
      } else if (f.status === "succeeded" && focus) {
        for (const n of ORDER) if (state[n] === "idle") state[n] = "done";
      }
    }
    for (const n of ORDER) {
      paint(n, state[n] === "active" ? C.lit : state[n] === "done" ? C.done : state[n] === "gate" ? C.gate : state[n] === "failed" ? C.failed : C.idle);
      world.remove(labels[n]); labels[n] = nodeLabel(n, counts[n] ? `${counts[n]} ${counts[n] === 1 ? "Flow" : "Flows"}` : ""); labels[n].position.set(pos[n].x, pos[n].y - 0.95, pos[n].z); world.add(labels[n]);
    }
    for (const [k, line] of Object.entries(edges)) {
      const b = k.split(">")[1];
      const lit = k === "review>code" ? loopLit || (focus?.steps ?? []).some((s) => s.step === "code" && s.attempt > 1) : (state[b] === "active" || state[b] === "gate" || (focus && state[b] === "done"));
      line.material.color.setHex(lit ? C.lit : C.edge);
    }
    labelEdges(focus);
  }

  // Bedienung: ziehen dreht, Rad zoomt, Klick auf einen Knoten wählt ihn; die Welt bewegt sich nur, wenn man sie bewegt
  let dragging = false, moved = 0, lastX = 0, lastY = 0, rotY = 0, rotX = 0.62, zoom = 15.5;
  const el = renderer.domElement;
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function pick(e) {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(Object.values(nodes), false)[0];
    return hit ? hit.object.userData.step : null;
  }
  el.style.cursor = "grab";
  el.addEventListener("pointerdown", (e) => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; el.setPointerCapture(e.pointerId); el.style.cursor = "grabbing"; });
  el.addEventListener("pointerup", (e) => {
    dragging = false; el.releasePointerCapture(e.pointerId); el.style.cursor = "grab";
    if (moved < 4 && onSelect) { const step = pick(e); if (step) onSelect(step); }
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) { el.style.cursor = pick(e) ? "pointer" : "grab"; return; }
    moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    rotY += (e.clientX - lastX) * 0.006; rotX = Math.max(0.15, Math.min(1.3, rotX + (e.clientY - lastY) * 0.004)); lastX = e.clientX; lastY = e.clientY;
  });
  // Zoomen nur mit Strg+Rad — das Rad allein soll die Seite scrollen, auch über der Karte
  el.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom = Math.max(9, Math.min(24, zoom + e.deltaY * 0.01)); }, { passive: false });

  function resize() { const w = container.clientWidth || 600, h = container.clientHeight || 360; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  let raf = 0; const clock = new THREE.Clock();
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    world.rotation.y = rotY;   // die Welt steht still, bis man sie dreht
    camera.position.set(0, Math.sin(rotX) * zoom, Math.cos(rotX) * zoom); camera.lookAt(0, -0.3, 0);
    for (const p of pulses) {
      if (!REDUCED) p.t = (p.t + dt * (p.speed ?? 0.4)) % 1;
      if (p.orbit) { const a = p.t * Math.PI * 2; p.mesh.position.set(p.at.x + Math.cos(a) * 0.75, p.at.y + 0.1, p.at.z + Math.sin(a) * 0.75); }
      else if (p.curve) { p.mesh.position.copy(p.curve.getPoint(p.t)); }
      else { p.mesh.position.set(p.at.x, p.at.y + 0.7 + Math.sin(p.t * Math.PI * 2) * 0.08, p.at.z); }
    }
    renderer.render(scene, camera);
  }
  frame();

  return {
    update,
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); container.innerHTML = ""; },
  };
}
