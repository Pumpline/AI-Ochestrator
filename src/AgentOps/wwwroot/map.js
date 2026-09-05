// Projektkarte: die Pipeline als Schiene — sechs Stationen auf einer Linie, die Schritte der Reihe nach.
// Ein laufender Flow ist ein Lichtpunkt, der die Schiene entlangläuft; die Runde review → code ist eine
// gestrichelte Rückführung unter der Schiene. Mit einem Fokus-Flow steht über jedem Abschnitt, wie lange
// der Schritt gebraucht hat und wie viele Tokens er gekostet hat. Klick auf eine Station → onSelect(step).
// Reines SVG, keine Bibliothek, Farben aus dem Seiten-Thema (CSS-Variablen).

const ORDER = ["plan", "code", "test", "review", "gate", "ship"];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NS = "http://www.w3.org/2000/svg";
const W = 1000, H = 300, Y = 128;          // interne Koordinaten, skaliert per viewBox
const X = (i) => 84 + i * 166.4;           // Stationen gleichmäßig über die Breite
const ARC = { from: 3, to: 1, dip: 262 };  // Rückführung review → code, unter der Schiene

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

const el = (name, attrs = {}, parent) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
// Punkt auf der Rückführung (quadratische Bézier) für Punkte, die review → code laufen
const arcPoint = (t) => {
  const p0 = { x: X(ARC.from), y: Y }, p1 = { x: X(ARC.to), y: Y }, c = { x: (p0.x + p1.x) / 2, y: ARC.dip };
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
};

export function mountProjectMap(container, { onSelect } = {}) {
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", class: "pmap" });
  container.prepend(svg);

  // Schiene: Abschnitte zwischen Nachbarn, dazu die gestrichelte Rückführung
  const segs = [];
  for (let i = 0; i < ORDER.length - 1; i++) {
    segs.push(el("line", { x1: X(i), y1: Y, x2: X(i + 1), y2: Y, class: "pm-seg" }, svg));
  }
  const arcPath = `M ${X(ARC.from)} ${Y} Q ${(X(ARC.from) + X(ARC.to)) / 2} ${ARC.dip} ${X(ARC.to)} ${Y}`;
  const arc = el("path", { d: arcPath, class: "pm-arc" }, svg);

  // Stationen: Kreis, das Gate ein Rhombus; Name darunter, Zähler darunter
  const nodes = {}, counts = {};
  ORDER.forEach((name, i) => {
    const g = el("g", { class: "pm-node", transform: `translate(${X(i)} ${Y})` }, svg);
    if (name === "gate") el("rect", { x: -14, y: -14, width: 28, height: 28, class: "pm-shape", transform: "rotate(45)" }, g);
    else el("circle", { r: 15, class: "pm-shape" }, g);
    el("text", { y: 44, class: "pm-label" }, g).textContent = name;
    const count = el("text", { y: 63, class: "pm-count" }, g);
    g.addEventListener("click", () => onSelect?.(name));
    nodes[name] = g; counts[name] = count;
  });

  // Bewegliches: Lichtpunkte je laufendem Flow, Puls am offenen Gate, Abschnitts-Beschriftungen im Fokus
  let pulses = [], gateRing = null, edgeLabels = [];

  function labelEdges(focus) {
    for (const t of edgeLabels) t.remove(); edgeLabels = [];
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
      const t = el("text", { class: "pm-elabel" }, svg);
      if (key === "plan") { t.setAttribute("x", X(0)); t.setAttribute("y", Y - 32); }
      else if (key === "review>code") { const p = arcPoint(0.5); t.setAttribute("x", p.x); t.setAttribute("y", p.y + 26); }
      else { const [a, b] = key.split(">"); t.setAttribute("x", (X(ORDER.indexOf(a)) + X(ORDER.indexOf(b))) / 2); t.setAttribute("y", Y - 32); }
      t.textContent = text; edgeLabels.push(t);
    }
  }

  function update(flows, focus = null) {
    const now = Date.now();
    const recent = (f) => now - (f.updatedAt ?? 0) < 30 * 60 * 1000;
    const state = Object.fromEntries(ORDER.map((n) => [n, "idle"]));
    const n = Object.fromEntries(ORDER.map((s) => [s, 0]));
    let loopLit = false;
    for (const p of pulses) p.dot.remove(); pulses = [];
    gateRing?.remove(); gateRing = null;

    for (const f of flows) {
      const step = f.currentStep && ORDER.includes(f.currentStep) ? f.currentStep : null;
      const i = step ? ORDER.indexOf(step) : -1;
      if (f.status === "running" && step) {
        n[step]++; state[step] = "active";
        const fromLoop = step === "code" && (f.state?.attempts?.code ?? 1) > 1;
        if (fromLoop) loopLit = true;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
        const dot = el("circle", { r: 5, class: "pm-pulse" }, svg);
        pulses.push({ dot, to: i, from: fromLoop ? null : i - 1, t: Math.random(), speed: 0.25 + Math.random() * 0.15 });
      } else if (f.status === "waiting" && f.wait?.kind === "gate") {
        n.gate++; state.gate = "gate";
        for (const s of ["plan", "code", "test", "review"]) if (state[s] === "idle") state[s] = "done";
        gateRing = el("circle", { cx: X(ORDER.indexOf("gate")), cy: Y, r: 15, class: "pm-gatering" }, svg);
      } else if ((f.status === "failed" || f.status === "blocked") && step && (recent(f) || focus)) {
        if (state[step] === "idle") state[step] = "failed"; n[step]++;
        for (let k = 0; k < i; k++) if (state[ORDER[k]] === "idle") state[ORDER[k]] = "done";
      } else if (f.status === "succeeded" && focus) {
        for (const s of ORDER) if (state[s] === "idle") state[s] = "done";
      }
    }
    for (const s of ORDER) {
      nodes[s].setAttribute("class", `pm-node ${state[s] === "idle" ? "" : state[s]}`);
      counts[s].textContent = n[s] ? `${n[s]} ${n[s] === 1 ? "Flow" : "Flows"}` : "";
    }
    for (let i = 0; i < segs.length; i++) {
      const b = ORDER[i + 1];
      const lit = state[b] === "active" || state[b] === "gate" || (focus && state[b] === "done");
      segs[i].setAttribute("class", `pm-seg${lit ? " lit" : ""}`);
    }
    arc.setAttribute("class", `pm-arc${loopLit || (focus?.steps ?? []).some((s) => s.step === "code" && s.attempt > 1) ? " lit" : ""}`);
    labelEdges(focus);
  }

  // Bewegung: Punkte laufen den Abschnitt entlang (oder der Rückführung nach), der Gate-Ring pulsiert
  let raf = 0; let last = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (!REDUCED) for (const p of pulses) {
      p.t = (p.t + dt * p.speed) % 1;
      if (p.from == null) { const a = arcPoint(1 - p.t); p.dot.setAttribute("cx", a.x); p.dot.setAttribute("cy", a.y); }
      else { const x = X(p.from) + (X(p.to) - X(p.from)) * p.t; p.dot.setAttribute("cx", x); p.dot.setAttribute("cy", Y); }
    }
    if (gateRing && !REDUCED) {
      const t = (now / 1200) % 1;
      gateRing.setAttribute("r", 15 + t * 14);
      gateRing.setAttribute("opacity", String(1 - t));
    }
  }
  raf = requestAnimationFrame(frame);
  update([], null);

  return {
    update,
    dispose() { cancelAnimationFrame(raf); svg.remove(); },
  };
}
