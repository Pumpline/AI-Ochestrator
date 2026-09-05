// Projektkarte in 3D: die Pipeline als Schiene durch den Raum — sechs Stationen auf einer Linie,
// ein laufender Flow ein Lichtpunkt, der die Schiene entlangläuft; die Runde review → code ist eine
// gestrichelte Rückführung unter der Schiene, das offene Gate pulsiert. Im Fokus steht über jedem
// Abschnitt, wie lange der Schritt gebraucht hat und wie viele Tokens er gekostet hat.
// Klick auf eine Station → onSelect(step). Ziehen dreht, Strg+Rad zoomt.
// Braucht THREE (r128, global) aus index.html; Farben kommen aus den CSS-Variablen des Themas.

const ORDER = ["plan", "code", "test", "review", "gate", "ship"];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const X3 = (i) => -6.6 + i * 2.64;          // Stationen auf der X-Achse
const ARC_DIP = -1.7;                        // Rückführung review → code, unter der Schiene

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

// Thema einlesen: CSS-Variable in eine THREE-Farbe — bei jedem update() frisch, die Karte folgt dem Umschalten
const cssColor = (name) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim());

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

export function mountProjectMap(container, { onSelect } = {}) {
  if (typeof THREE === "undefined") { container.insertAdjacentHTML("afterbegin", `<div class="empty" style="padding-top:40px">3D-Karte braucht WebGL und three.js.</div>`); return { update() {}, dispose() {} }; }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.prepend(renderer.domElement);
  const world = new THREE.Group(); scene.add(world);

  // Stationen: Kugeln, das Gate ein Rhombus — Farbe trägt den Zustand
  const nodes = {}, labels = {};
  ORDER.forEach((name, i) => {
    const geo = name === "gate" ? new THREE.OctahedronGeometry(0.42) : new THREE.SphereGeometry(0.34, 24, 18);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    mesh.position.set(X3(i), 0, 0); mesh.userData.step = name;
    world.add(mesh); nodes[name] = mesh;
  });

  // Schiene: Röhren zwischen den Nachbarn, dazu die gestrichelte Rückführung review → code
  const segs = [];
  for (let i = 0; i < ORDER.length - 1; i++) {
    const a = new THREE.Vector3(X3(i), 0, 0), b = new THREE.Vector3(X3(i + 1), 0, 0);
    const len = a.distanceTo(b);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    tube.position.copy(a.clone().add(b).multiplyScalar(0.5));
    tube.rotation.z = Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2;
    world.add(tube); segs.push(tube);
  }
  const arcCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(X3(3), 0, 0),
    new THREE.Vector3((X3(3) + X3(1)) / 2, ARC_DIP, 0),
    new THREE.Vector3(X3(1), 0, 0),
  );
  const arc = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(arcCurve.getPoints(48)),
    new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.18, gapSize: 0.13 }),
  );
  arc.computeLineDistances(); world.add(arc);

  // Bewegliches: Lichtpunkte je laufendem Flow, pulsierender Ring am offenen Gate, Beschriftungen
  const pulseGeo = new THREE.SphereGeometry(0.1, 12, 12);
  let pulses = [], gateRing = null, edgeLabels = [];
  const ringTexture = () => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const ctx = c.getContext("2d");
    ctx.strokeStyle = cssColor("--warning").getStyle(); ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(64, 64, 50, 0, Math.PI * 2); ctx.stroke();
    const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter; return t;
  };

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
    const text = cssColor("--text-dim").getStyle();
    for (const [key, items] of byEdge) {
      const ms = items.reduce((a, x) => a + (x.durationMs ?? 0), 0);
      const tok = items.some((x) => x.tokens != null) ? items.reduce((a, x) => a + (x.tokens ?? 0), 0) : null;
      const str = [items.length > 1 ? `${items.length}×` : "", fmtDuration(ms), tok != null ? `${fmtTokens(tok)} tok` : ""].filter(Boolean).join(" · ");
      if (!str) continue;
      const l = sprite([[str, "600 30px 'JetBrains Mono', monospace", text]], 1);
      if (key === "plan") l.position.set(X3(0), 0.85, 0);
      else if (key === "review>code") l.position.copy(arcCurve.getPoint(0.5)).add(new THREE.Vector3(0, -0.55, 0));
      else { const [a, b] = key.split(">"); l.position.set((X3(ORDER.indexOf(a)) + X3(ORDER.indexOf(b))) / 2, 0.85, 0); }
      world.add(l); edgeLabels.push(l);
    }
  }

  function update(flows, focus = null) {
    const accent = cssColor("--accent"), done = cssColor("--success"), gate = cssColor("--warning"),
      failed = cssColor("--danger"), idle = cssColor("--track"), panel = cssColor("--panel"),
      muted = cssColor("--text-muted").getStyle(), dim = cssColor("--text-faint").getStyle();
    const now = Date.now();
    const recent = (f) => now - (f.updatedAt ?? 0) < 30 * 60 * 1000;
    const state = Object.fromEntries(ORDER.map((n) => [n, "idle"]));
    const n = Object.fromEntries(ORDER.map((s) => [s, 0]));
    let loopLit = false;
    for (const p of pulses) world.remove(p.mesh); pulses = [];
    if (gateRing) { world.remove(gateRing); gateRing = null; }

    for (const f of flows) {
      const step = f.currentStep && ORDER.includes(f.currentStep) ? f.currentStep : null;
      const i = step ? ORDER.indexOf(step) : -1;
      if (f.status === "running" && step) {
        n[step]++; state[step] = "active";
        const fromLoop = step === "code" && (f.state?.attempts?.code ?? 1) > 1;
        if (fromLoop) loopLit = true;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
        const mesh = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: accent }));
        world.add(mesh);
        pulses.push({ mesh, to: i, from: fromLoop ? null : i - 1, t: Math.random(), speed: 0.25 + Math.random() * 0.15 });
      } else if (f.status === "waiting" && f.wait?.kind === "gate") {
        n.gate++; state.gate = "gate";
        for (const s of ["plan", "code", "test", "review"]) if (state[s] === "idle") state[s] = "done";
        gateRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), transparent: true, depthWrite: false, depthTest: false }));
        gateRing.position.copy(nodes.gate.position); gateRing.scale.set(1, 1, 1);
        world.add(gateRing);
      } else if ((f.status === "failed" || f.status === "blocked") && step && (recent(f) || focus)) {
        if (state[step] === "idle") state[step] = "failed"; n[step]++;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
      } else if (f.status === "succeeded" && focus) {
        for (const s of ORDER) if (state[s] === "idle") state[s] = "done";
      }
    }
    for (const s of ORDER) {
      nodes[s].material.color.copy(state[s] === "active" ? accent : state[s] === "done" ? done : state[s] === "gate" ? gate : state[s] === "failed" ? failed : idle);
      world.remove(labels[s]);
      labels[s] = sprite([[s.toUpperCase(), "600 34px 'Space Grotesk', sans-serif", state[s] === "idle" ? dim : muted], ...(n[s] ? [[`${n[s]} ${n[s] === 1 ? "Flow" : "Flows"}`, "26px 'JetBrains Mono', monospace", dim]] : [])]);
      labels[s].position.set(nodes[s].position.x, -0.95, 0); world.add(labels[s]);
    }
    for (let i = 0; i < segs.length; i++) {
      const b = ORDER[i + 1];
      const lit = state[b] === "active" || state[b] === "gate" || (focus && state[b] === "done");
      segs[i].material.color.copy(lit ? accent : idle);
    }
    arc.material.color.copy(loopLit || (focus?.steps ?? []).some((s) => s.step === "code" && s.attempt > 1) ? accent : idle);
    labelEdges(focus);
  }

  // Bedienung: ziehen dreht, Strg+Rad zoomt, Klick auf eine Station wählt sie
  let dragging = false, moved = 0, lastX = 0, lastY = 0, rotY = 0, rotX = 0.38, zoom = 11;
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
    rotY += (e.clientX - lastX) * 0.006; rotX = Math.max(0.08, Math.min(1.1, rotX + (e.clientY - lastY) * 0.004)); lastX = e.clientX; lastY = e.clientY;
  });
  el.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom = Math.max(6, Math.min(18, zoom + e.deltaY * 0.01)); }, { passive: false });

  function resize() { const w = container.clientWidth || 600, h = container.clientHeight || 360; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  let raf = 0; let last = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    world.rotation.y = rotY;
    camera.position.set(0, Math.sin(rotX) * zoom, Math.cos(rotX) * zoom); camera.lookAt(0, -0.1, 0);
    for (const s of ORDER) nodes[s].rotation.y += 0;   // Stationen stehen still — nur die Punkte laufen
    if (!REDUCED) for (const p of pulses) {
      p.t = (p.t + dt * p.speed) % 1;
      if (p.from == null) p.mesh.position.copy(arcCurve.getPoint(1 - p.t));
      else p.mesh.position.set(X3(p.from) + (X3(p.to) - X3(p.from)) * p.t, 0, 0);
    }
    if (gateRing && !REDUCED) {
      const t = (now / 1200) % 1;
      gateRing.scale.setScalar(0.9 + t * 1.1);
      gateRing.material.opacity = 1 - t;
    }
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);
  update([], null);

  return {
    update,
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
