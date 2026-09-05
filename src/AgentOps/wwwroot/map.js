// Projektkarte in 3D: der Master in der Mitte, die Agenten des Projekts um ihn herum verstreut —
// jeder auf eigener Höhe, Tiefe und Radius, kein ordentlicher Ring. Der Graph kommt aus dem Flow des
// Projekts (flow.json): Standardkanten laufen als Röhren außen herum, Verzweigungen (bei einem Urteil)
// schwingen als gestrichelte Kurven unter dem Master durch. Ein laufender Flow ist ein Lichtpunkt auf der
// Kante zum aktuellen Knoten; arbeitet ein Knoten, leuchtet die Speiche vom Master zu ihm. Im Fokus steht
// an jeder genommenen Kante, wie lange der Schritt gebraucht hat und wie viele Tokens er gekostet hat.
// Klick auf einen Knoten → onSelect(id). Ziehen dreht, Strg+Rad zoomt.
// Braucht THREE (r128, global) aus index.html; Farben kommen aus den CSS-Variablen des Themas.

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const CENTER = new THREE.Vector3(0, 0.15, 0);
// Der Standard-Graph — die Pipeline der ersten Fassung; gilt, solange das Cockpit keinen Flow übergibt
export const DEFAULT_GRAPH = {
  nodes: [{ id: "plan", kind: "agent" }, { id: "code", kind: "agent" }, { id: "test", kind: "agent" }, { id: "review", kind: "agent" }, { id: "gate", kind: "gate" }, { id: "ship", kind: "agent" }],
  edges: [{ from: "plan", to: "code" }, { from: "code", to: "test" }, { from: "test", to: "review" }, { from: "review", to: "gate" }, { from: "gate", to: "ship" }, { from: "review", to: "code", on: "REQUEST_CHANGES" }],
  path: ["plan", "code", "test", "review", "gate", "ship"],
};
// Winkel (°), Radius und Höhe je Station — bewusst unregelmäßig: Abstände zum Master von 3,1 bis 5,6,
// Lücken von 38° bis 88°, Höhen, die nicht oben-unten alternieren. Wirkt gewachsen, nicht geplant.
const ANGLES = [-170, -88, -50, 38, 100, 160];
const RADII = [5.6, 3.1, 5.1, 3.4, 5.4, 4.1];
const HEIGHTS = [-0.4, -1.1, 0.9, 0.2, 1.4, -0.9];
function place(i, n) {
  const deg = n <= ANGLES.length ? ANGLES[i] : -170 + (i * 330) / Math.max(n - 1, 1);
  const a = (deg * Math.PI) / 180; const r = RADII[i % RADII.length]; const y = HEIGHTS[i % HEIGHTS.length];
  return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
}

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
const edgeKey = (e) => `${e.from}>${e.to}`;

export function mountProjectMap(container, { onSelect } = {}) {
  if (typeof THREE === "undefined") { container.insertAdjacentHTML("afterbegin", `<div class="empty" style="padding-top:40px">3D-Karte braucht WebGL und three.js.</div>`); return { update() {}, dispose() {} }; }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.prepend(renderer.domElement);
  const world = new THREE.Group(); scene.add(world);

  // Master in der Mitte als Drahtgitter — er bleibt, der Graph um ihn herum wird je Flow neu gebaut
  const master = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.85 }));
  master.position.copy(CENTER); world.add(master);
  const masterLabel = sprite([["MASTER", "600 34px 'Space Grotesk', sans-serif", "#ffffff"]]);
  masterLabel.position.copy(CENTER).add(new THREE.Vector3(0, -1.05, 0)); world.add(masterLabel);

  // Der aufgebaute Graph: Positionen, Kurven, Röhren, Speichen, Knoten, Beschriftungen
  let g = null;   // { sig, graph, POS, curves, tubes, spokes, nodes, labels, group }
  const pulseGeo = new THREE.SphereGeometry(0.1, 12, 12);
  let pulses = [], gateRings = [], edgeLabels = [];
  const ringTexture = () => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const ctx = c.getContext("2d");
    ctx.strokeStyle = cssColor("--warning").getStyle(); ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(64, 64, 50, 0, Math.PI * 2); ctx.stroke();
    const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter; return t;
  };

  function build(graph) {
    if (g) { world.remove(g.group); g = null; }
    const group = new THREE.Group(); world.add(group);
    const ids = graph.nodes.map((n) => n.id);
    const POS = Object.fromEntries(ids.map((id, i) => [id, place(i, ids.length)]));
    // Standardkante: außen herum, vom Zentrum weggedrückt; Verzweigung: unter dem Master durch
    const curves = {};
    for (const e of graph.edges) {
      if (!POS[e.from] || !POS[e.to]) continue;
      if (e.on) curves[edgeKey(e)] = new THREE.QuadraticBezierCurve3(POS[e.from].clone(), CENTER.clone().add(new THREE.Vector3(0, -2.1, 0)), POS[e.to].clone());
      else {
        const mid = POS[e.from].clone().add(POS[e.to]).multiplyScalar(0.5);
        const out = mid.clone().sub(CENTER).setY(0).normalize();
        curves[edgeKey(e)] = new THREE.QuadraticBezierCurve3(POS[e.from].clone(), mid.addScaledVector(out, 1.3), POS[e.to].clone());
      }
    }
    const tubes = {};
    for (const e of graph.edges) {
      const key = edgeKey(e); const curve = curves[key]; if (!curve) continue;
      if (e.on) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.2, gapSize: 0.14 }));
        line.computeLineDistances(); group.add(line); tubes[key] = line;
      } else {
        const t = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 0.035, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        group.add(t); tubes[key] = t;
      }
    }
    const spokes = {}, nodes = {}, labels = {};
    for (const n of graph.nodes) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([CENTER, POS[n.id]]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
      group.add(line); spokes[n.id] = line;
      const geo = n.kind === "gate" ? new THREE.OctahedronGeometry(0.42) : new THREE.SphereGeometry(0.34, 24, 18);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mesh.position.copy(POS[n.id]); mesh.userData.step = n.id; group.add(mesh); nodes[n.id] = mesh;
    }
    g = { sig: signature(graph), graph, POS, curves, tubes, spokes, nodes, labels, group };
  }
  const signature = (graph) => JSON.stringify([graph.nodes.map((n) => `${n.id}:${n.kind}`), graph.edges.map((e) => `${edgeKey(e)}${e.on ? "?" + e.on : ""}`)]);

  function labelEdges(focus, text) {
    for (const l of edgeLabels) world.remove(l); edgeLabels = [];
    if (!focus || !g) return;
    // Die genommenen Kanten aus der Reihenfolge der Schritte; die erste Station bekommt ihr Schild über dem Knoten
    const steps = focus.steps ?? []; const byEdge = new Map();
    steps.forEach((s, i) => {
      const key = i === 0 ? `@${s.step}` : `${steps[i - 1].step}>${s.step}`;
      byEdge.set(key, (byEdge.get(key) ?? []).concat([s]));
    });
    if (focus.gate?.waitMs != null && focus.gate.gate) {
      const before = steps.at(-1)?.step;
      const key = before && g.curves[`${before}>${focus.gate.gate}`] ? `${before}>${focus.gate.gate}` : `@${focus.gate.gate}`;
      byEdge.set(key, (byEdge.get(key) ?? []).concat([{ durationMs: focus.gate.waitMs, tokens: null }]));
    }
    for (const [key, items] of byEdge) {
      const ms = items.reduce((a, x) => a + (x.durationMs ?? 0), 0);
      const tok = items.some((x) => x.tokens != null) ? items.reduce((a, x) => a + (x.tokens ?? 0), 0) : null;
      const str = [items.length > 1 ? `${items.length}×` : "", fmtDuration(ms), tok != null ? `${fmtTokens(tok)} tok` : ""].filter(Boolean).join(" · ");
      if (!str) continue;
      const l = sprite([[str, "600 30px 'JetBrains Mono', monospace", text]], 1);
      if (key.startsWith("@")) { const p = g.POS[key.slice(1)]; if (!p) continue; l.position.copy(p).add(new THREE.Vector3(0, 0.85, 0)); }
      else {
        const curve = g.curves[key]; if (!curve) continue;
        const p = curve.getPoint(0.5); const branch = g.graph.edges.find((e) => edgeKey(e) === key)?.on;
        const out = branch ? new THREE.Vector3(0, -0.6, 0) : p.clone().sub(CENTER).setY(0).normalize().multiplyScalar(0.45).setY(0.55);
        l.position.copy(p).add(out);
      }
      world.add(l); edgeLabels.push(l);
    }
  }

  function update(flows, focus = null, graph = DEFAULT_GRAPH) {
    if (!g || g.sig !== signature(graph)) build(graph);
    const accent = cssColor("--accent"), done = cssColor("--success"), gate = cssColor("--warning"),
      failed = cssColor("--danger"), idle = cssColor("--track"), faint = cssColor("--text-faint"),
      muted = cssColor("--text-muted").getStyle(), dim = cssColor("--text-faint").getStyle();
    const now = Date.now();
    const recent = (f) => now - (f.updatedAt ?? 0) < 30 * 60 * 1000;
    const ids = g.graph.nodes.map((n) => n.id);
    const state = Object.fromEntries(ids.map((n) => [n, "idle"]));
    const count = Object.fromEntries(ids.map((n) => [n, 0]));
    const litEdges = new Set();
    for (const p of pulses) world.remove(p.mesh); pulses = [];
    for (const r of gateRings) world.remove(r); gateRings = [];
    const mark = (id, s) => { if (id in state && (state[id] === "idle" || s === "active" || s === "gate" || s === "failed")) state[id] = s; };

    for (const f of flows) {
      const steps = f.state?.steps ?? [];
      const cur = f.currentStep && ids.includes(f.currentStep) ? f.currentStep : null;
      const ended = steps.filter((s) => s.endedAt != null);
      for (const s of ended) mark(s.step, "done");
      // Genommene Kanten leuchten (im Fokus); die Kante zum aktuellen Knoten kommt vom zuletzt beendeten Schritt
      if (focus) for (const k of Object.keys(f.state?.edgeCounts ?? {})) if (g.curves[k]) litEdges.add(k);
      const prev = ended.at(-1)?.step;
      if (f.status === "running" && cur) {
        count[cur]++; mark(cur, "active");
        const key = prev && g.curves[`${prev}>${cur}`] ? `${prev}>${cur}` : null;
        if (key) litEdges.add(key);
        const mesh = new THREE.Mesh(pulseGeo, new THREE.MeshBasicMaterial({ color: accent }));
        world.add(mesh);
        pulses.push({ mesh, curve: key ? g.curves[key] : null, at: g.POS[cur], t: Math.random(), speed: 0.25 + Math.random() * 0.15 });
      } else if (f.status === "waiting" && f.wait?.kind === "gate" && cur) {
        count[cur]++; mark(cur, "gate");
        const key = prev && g.curves[`${prev}>${cur}`] ? `${prev}>${cur}` : null; if (key) litEdges.add(key);
        const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), transparent: true, depthWrite: false, depthTest: false }));
        ring.position.copy(g.POS[cur]); ring.scale.set(1, 1, 1); world.add(ring); gateRings.push(ring);
      } else if ((f.status === "failed" || f.status === "blocked") && cur && (recent(f) || focus)) {
        count[cur]++; mark(cur, "failed");
      } else if (f.status === "succeeded" && focus) {
        for (const s of steps) mark(s.step, "done");
        for (const n of g.graph.nodes) if (n.kind === "gate" && state[n.id] === "idle" && ended.length) state[n.id] = "done";
      }
    }
    for (const id of ids) {
      g.nodes[id].material.color.copy(state[id] === "active" ? accent : state[id] === "done" ? done : state[id] === "gate" ? gate : state[id] === "failed" ? failed : idle);
      if (g.labels[id]) world.remove(g.labels[id]);
      g.labels[id] = sprite([[id.toUpperCase(), "600 34px 'Space Grotesk', sans-serif", state[id] === "idle" ? dim : muted], ...(count[id] ? [[`${count[id]} ${count[id] === 1 ? "Flow" : "Flows"}`, "26px 'JetBrains Mono', monospace", dim]] : [])]);
      g.labels[id].position.copy(g.POS[id]).add(new THREE.Vector3(0, -0.95, 0)); world.add(g.labels[id]);
      // Speiche zum Master leuchtet, wenn die Station arbeitet oder wartet
      const spokeLit = state[id] === "active" || state[id] === "gate";
      g.spokes[id].material.color.copy(spokeLit ? accent : faint);
      g.spokes[id].material.opacity = spokeLit ? 0.8 : 0.3;
    }
    master.material.color.copy(faint);
    masterLabel.material.map.dispose();
    masterLabel.material.map = sprite([["MASTER", "600 34px 'Space Grotesk', sans-serif", muted]]).material.map;
    for (const [k, t] of Object.entries(g.tubes)) {
      const to = k.split(">")[1];
      const lit = litEdges.has(k) || state[to] === "active" || state[to] === "gate" || (focus && state[to] === "done" && !g.graph.edges.find((e) => edgeKey(e) === k)?.on);
      t.material.color.copy(lit ? accent : idle);
    }
    labelEdges(focus, dim);
  }

  // Bedienung: ziehen dreht, Strg+Rad zoomt, Klick auf eine Station wählt sie
  let dragging = false, moved = 0, lastX = 0, lastY = 0, rotY = 0, rotX = 0.52, zoom = 14;
  const el = renderer.domElement;
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function pick(e) {
    if (!g) return null;
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(Object.values(g.nodes), false)[0];
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
    if (gateRings.length && !REDUCED) {
      const t = (now / 1200) % 1;
      for (const r of gateRings) { r.scale.setScalar(0.9 + t * 1.1); r.material.opacity = 1 - t; }
    }
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);
  update([], null, DEFAULT_GRAPH);

  return {
    update,
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
