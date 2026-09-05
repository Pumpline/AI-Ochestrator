// Projektkarte in 3D: der Master in der Mitte, die Schritt-Agenten um ihn herum verstreut —
// jeder auf eigener Höhe, Tiefe und Radius, kein ordentlicher Ring. Die Pipeline läuft in Bögen
// außen herum (plan → … → ship), ein laufender Flow ist ein Lichtpunkt auf dem Bogen zum aktuellen
// Schritt; arbeitet ein Schritt, leuchtet die Speiche vom Master zu ihm. Die Runde review → code
// schwingt als gestrichelte Kurve unter dem Master durch. Im Fokus steht über jedem Bogen, wie
// lange der Schritt gebraucht hat und wie viele Tokens er gekostet hat.
// Klick auf eine Station → onSelect(step). Ziehen dreht, Strg+Rad zoomt.
// Braucht THREE (r128, global) aus index.html; Farben kommen aus den CSS-Variablen des Themas.

const ORDER = ["plan", "code", "test", "review", "gate", "ship"];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const CENTER = new THREE.Vector3(0, 0.15, 0);
// Winkel (°), Radius und Höhe je Station — bewusst unregelmäßig: Abstände zum Master von 3,1 bis 5,6,
// Lücken von 38° bis 88°, Höhen, die nicht oben-unten alternieren. Wirkt gewachsen, nicht geplant.
const PLACE = { plan: [-170, 5.6, -0.4], code: [-88, 3.1, -1.1], test: [-50, 5.1, 0.9], review: [38, 3.4, 0.2], gate: [100, 5.4, 1.4], ship: [160, 4.1, -0.9] };
const POS = Object.fromEntries(Object.entries(PLACE).map(([s, [deg, r, y]]) => {
  const a = deg * Math.PI / 180;
  return [s, new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)];
}));

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

  // Bogen zwischen zwei Stationen: außen herum, vom Zentrum weggedrückt
  const arcBetween = (a, b) => {
    const mid = POS[a].clone().add(POS[b]).multiplyScalar(0.5);
    const out = mid.clone().sub(CENTER).setY(0).normalize();
    return new THREE.QuadraticBezierCurve3(POS[a].clone(), mid.addScaledVector(out, 1.3), POS[b].clone());
  };
  const curves = {};
  for (let i = 0; i < ORDER.length - 1; i++) curves[`${ORDER[i]}>${ORDER[i + 1]}`] = arcBetween(ORDER[i], ORDER[i + 1]);
  // Rückführung review → code: unter dem Master durch
  curves["review>code"] = new THREE.QuadraticBezierCurve3(POS.review.clone(), CENTER.clone().add(new THREE.Vector3(0, -2.1, 0)), POS.code.clone());

  const tubes = {}, spokes = {};
  for (const [key, curve] of Object.entries(curves)) {
    if (key === "review>code") {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.2, gapSize: 0.14 }));
      line.computeLineDistances(); world.add(line); tubes[key] = line;
    } else {
      const t = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 0.035, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      world.add(t); tubes[key] = t;
    }
  }
  // Speichen vom Master zu jeder Station
  for (const s of ORDER) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([CENTER, POS[s]]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    world.add(line); spokes[s] = line;
  }

  // Stationen: Kugeln, das Gate ein Rhombus. Master in der Mitte als Drahtgitter.
  const nodes = {}, labels = {};
  ORDER.forEach((name) => {
    const geo = name === "gate" ? new THREE.OctahedronGeometry(0.42) : new THREE.SphereGeometry(0.34, 24, 18);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    mesh.position.copy(POS[name]); mesh.userData.step = name;
    world.add(mesh); nodes[name] = mesh;
  });
  const master = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.85 }));
  master.position.copy(CENTER); world.add(master);
  const masterLabel = sprite([["MASTER", "600 34px 'Space Grotesk', sans-serif", "#ffffff"]]);
  masterLabel.position.copy(CENTER).add(new THREE.Vector3(0, -1.05, 0)); world.add(masterLabel);

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
      if (key === "plan") l.position.copy(POS.plan).add(new THREE.Vector3(0, 0.85, 0));
      else {
        const p = curves[key].getPoint(0.5);
        const out = key === "review>code" ? new THREE.Vector3(0, -0.6, 0) : p.clone().sub(CENTER).setY(0).normalize().multiplyScalar(0.45).setY(0.55);
        l.position.copy(p).add(out);
      }
      world.add(l); edgeLabels.push(l);
    }
  }

  function update(flows, focus = null) {
    const accent = cssColor("--accent"), done = cssColor("--success"), gate = cssColor("--warning"),
      failed = cssColor("--danger"), idle = cssColor("--track"), faint = cssColor("--text-faint"),
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
        const key = fromLoop ? "review>code" : i > 0 ? `${ORDER[i - 1]}>${step}` : null;
        if (fromLoop) loopLit = true;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
        const mesh = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: accent }));
        world.add(mesh);
        pulses.push({ mesh, curve: key ? curves[key] : null, at: POS[step], t: Math.random(), speed: 0.25 + Math.random() * 0.15 });
      } else if (f.status === "waiting" && f.wait?.kind === "gate") {
        n.gate++; state.gate = "gate";
        for (const s of ["plan", "code", "test", "review"]) if (state[s] === "idle") state[s] = "done";
        gateRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), transparent: true, depthWrite: false, depthTest: false }));
        gateRing.position.copy(POS.gate); gateRing.scale.set(1, 1, 1);
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
      labels[s].position.copy(POS[s]).add(new THREE.Vector3(0, -0.95, 0)); world.add(labels[s]);
      // Speiche zum Master leuchtet, wenn die Station arbeitet oder wartet
      const spokeLit = state[s] === "active" || state[s] === "gate";
      spokes[s].material.color.copy(spokeLit ? accent : faint);
      spokes[s].material.opacity = spokeLit ? 0.8 : 0.3;
    }
    master.material.color.copy(faint);
    masterLabel.material.map.dispose();
    masterLabel.material.map = sprite([["MASTER", "600 34px 'Space Grotesk', sans-serif", muted]]).material.map;
    for (const [k, t] of Object.entries(tubes)) {
      const b = k.split(">")[1];
      const lit = k === "review>code" ? loopLit || (focus?.steps ?? []).some((s) => s.step === "code" && s.attempt > 1) : state[b] === "active" || state[b] === "gate" || (focus && state[b] === "done");
      t.material.color.copy(lit ? accent : idle);
    }
    labelEdges(focus);
  }

  // Bedienung: ziehen dreht, Strg+Rad zoomt, Klick auf eine Station wählt sie
  let dragging = false, moved = 0, lastX = 0, lastY = 0, rotY = 0, rotX = 0.52, zoom = 14;
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
    rotY += (e.clientX - lastX) * 0.006; rotX = Math.max(0.12, Math.min(1.2, rotX + (e.clientY - lastY) * 0.004)); lastX = e.clientX; lastY = e.clientY;
  });
  el.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom = Math.max(7, Math.min(20, zoom + e.deltaY * 0.01)); }, { passive: false });

  function resize() { const w = container.clientWidth || 600, h = container.clientHeight || 360; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  let raf = 0; let last = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    world.rotation.y = rotY;
    master.rotation.y += REDUCED ? 0 : dt * 0.2;   // der Master dreht langsam immer
    camera.position.set(0, Math.sin(rotX) * zoom, Math.cos(rotX) * zoom); camera.lookAt(0, 0, 0);
    if (!REDUCED) for (const p of pulses) {
      p.t = (p.t + dt * p.speed) % 1;
      if (p.curve) p.mesh.position.copy(p.curve.getPoint(p.t));
      else p.mesh.position.copy(p.at).add(new THREE.Vector3(0, 0.7 + Math.sin(p.t * Math.PI * 2) * 0.08, 0));
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
