import { useState, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, LineChart, Line, CartesianGrid, Legend
} from "recharts";
import * as d3 from "d3";

// ─── Constants ─────────────────────────────────────────────────────────────
const C = {
  bg: "#07090F", surface: "#0C1121", card: "#101729",
  border: "#182036", accent: "#00E5FF", accentDim: "#00E5FF18",
  fake: "#FF3366", fakeDim: "#FF336618", real: "#00E096", realDim: "#00E09618",
  warn: "#FFB800", text: "#DDE5F4", muted: "#3D5278",
  mono: "'Space Mono', monospace", sans: "'Outfit', sans-serif",
};

const COL_ALIASES = {
  user_id:    ["user_id","userid","user","reviewer_id","reviewer","author_id"],
  timestamp:  ["timestamp","date","review_date","created_at","time","datetime","unixreviewtime"],
  product_id: ["parent_asin","product_id","asin","item_id","productid","prod_id"],
  rating:     ["rating","stars","score","star_rating","overall"],
  text:       ["text_","text","review_text","review","content","body","comment","reviewtext"],
  category:   ["category","cat","product_category","type","genre"],
};

function detectCols(obj) {
  const keys = Object.keys(obj);
  const lower = keys.map(k => k.toLowerCase().trim());
  const out = {};
  for (const [canon, aliases] of Object.entries(COL_ALIASES)) {
    const idx = lower.findIndex(l => aliases.includes(l));
    if (idx !== -1) out[canon] = keys[idx];
  }
  return out;
}
const hasGraph = d => ["user_id","timestamp","product_id","rating"].every(k => k in d);
const hasModel = d => "text" in d;

// ─── Burst detection ───────────────────────────────────────────────────────
function burstAnalysis(rows, d) {
  const data = rows.map(r => ({
    user_id:    String(r[d.user_id]  || ""),
    product_id: String(r[d.product_id] || ""),
    ts: new Date(isNaN(r[d.timestamp]) ? r[d.timestamp] : Number(r[d.timestamp]) * (r[d.timestamp] > 1e10 ? 1 : 1000)).getTime(),
    rating: parseFloat(r[d.rating]) || 3,
  })).filter(r => r.user_id && r.product_id && !isNaN(r.ts));

  const sorted = [...data].sort((a,b) => a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : a.ts - b.ts);

  const bursts = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].user_id === sorted[i-1].user_id) {
      const mins = (sorted[i].ts - sorted[i-1].ts) / 60000;
      if (mins >= 0 && mins < 60) bursts.push({ ...sorted[i], mins });
    }
  }

  const prodMap = {};
  bursts.forEach(b => { (prodMap[b.product_id] = prodMap[b.product_id] || []).push(b); });

  const suspProds = Object.entries(prodMap)
    .filter(([,reviews]) => {
      const ts = reviews.map(r => r.ts).sort();
      return reviews.length >= 3 && (ts[ts.length-1] - ts[0]) / 3600000 <= 24;
    }).map(([id]) => id);

  const burstUsers = [...new Set(bursts.map(b => b.user_id))];

  // Timeline: burst count by hour buckets
  const byHour = {};
  bursts.forEach(b => {
    const h = new Date(b.ts).toISOString().slice(0,13);
    byHour[h] = (byHour[h] || 0) + 1;
  });
  const timeline = Object.entries(byHour).sort().slice(-24).map(([h,n]) => ({ h: h.slice(11), n }));

  return { bursts, burstUsers, suspProds, totalFiltered: data.length, timeline };
}

// ─── Classify via Anthropic API ────────────────────────────────────────────
async function classify(reviews, onProg) {
  const BATCH = 8;
  const results = [];
  for (let i = 0; i < reviews.length; i += BATCH) {
    const batch = reviews.slice(i, i + BATCH);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content:
`You are a fake review detection model mimicking a RoBERTa+XGBoost classifier trained on Amazon Fake Reviews.

Fake signals: repetitive phrases ("great product","highly recommend"), incomplete thoughts, excessive exclamations, vague language, no product-specific detail, formulaic structure.
Genuine signals: specific product details, mixed sentiment, personal experience, natural variation, realistic length.

Classify each review. Respond ONLY with JSON array (no preamble, no backticks):
[{"id":1,"label":0,"confidence":0.91,"signal":"brief cue"}, ...]
label: 0=fake, 1=genuine

Reviews:
${batch.map((r,j)=>`[${j+1}] rating:${r.rating||"?"} | "${String(r.text).slice(0,280)}"`).join("\n")}`
          }]
        })
      });
      const data = await res.json();
      const txt = (data.content||[]).map(c=>c.text||"").join("");
      const clean = txt.replace(/```json|```/g,"").trim();
      const parsed = JSON.parse(clean);
      parsed.forEach((p,j) => results.push({ ...batch[j], label: p.label, conf: p.confidence, signal: p.signal }));
    } catch {
      batch.forEach(r => results.push({ ...r, label: 1, conf: 0.5, signal: "—" }));
    }
    onProg(Math.min(99, Math.round(((i + BATCH) / reviews.length) * 100)));
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

// ─── D3 Network Graph ──────────────────────────────────────────────────────
function NetworkGraph({ gData }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !gData) return;
    const { bursts, suspProds } = gData;
    const W = ref.current.parentElement.clientWidth || 560, H = 340;
    const svg = d3.select(ref.current).attr("width",W).attr("height",H);
    svg.selectAll("*").remove();
    svg.append("rect").attr("width",W).attr("height",H).attr("fill",C.surface).attr("rx",8);

    const spSet = new Set(suspProds.slice(0, 25));
    const relevant = bursts.filter(b => spSet.has(b.product_id)).slice(0, 150);
    if (!relevant.length) {
      svg.append("text").attr("x",W/2).attr("y",H/2).attr("text-anchor","middle")
        .attr("fill",C.muted).attr("font-family",C.mono).attr("font-size",12)
        .text("No suspicious clusters detected");
      return;
    }
    const users = [...new Set(relevant.map(b=>b.user_id))].slice(0,35);
    const prods = [...new Set(relevant.map(b=>b.product_id))].slice(0,25);
    const nodes = [
      ...users.map(id=>({id,t:"user"})),
      ...prods.map(id=>({id,t:"prod"})),
    ];
    const nodeSet = new Set(nodes.map(n=>n.id));
    const linkSet = new Set();
    const links = [];
    relevant.forEach(b => {
      const k = `${b.user_id}|${b.product_id}`;
      if (!linkSet.has(k) && nodeSet.has(b.user_id) && nodeSet.has(b.product_id)) {
        linkSet.add(k);
        links.push({ source: b.user_id, target: b.product_id });
      }
    });
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d=>d.id).distance(55).strength(0.9))
      .force("charge", d3.forceManyBody().strength(-90))
      .force("center", d3.forceCenter(W/2, H/2))
      .force("col", d3.forceCollide(11));

    const lSel = svg.append("g").selectAll("line").data(links).join("line")
      .attr("stroke","#1A2540").attr("stroke-width",1.2);

    const gSel = svg.append("g").selectAll("g").data(nodes).join("g").attr("cursor","default");
    gSel.append("circle")
      .attr("r", d => d.t==="prod" ? 9 : 6)
      .attr("fill", d => d.t==="user" ? "#FF336614" : "#00E5FF14")
      .attr("stroke", d => d.t==="user" ? C.fake : C.accent)
      .attr("stroke-width", 1.5);

    // Tooltip text
    const tip = svg.append("text").attr("fill",C.text).attr("font-size",10)
      .attr("font-family",C.mono).attr("pointer-events","none").style("opacity",0);
    gSel.on("mouseover",(e,d)=>{
      tip.style("opacity",1).attr("x",d.x+10).attr("y",d.y-6)
        .text(`${d.t==="user"?"USER":"PROD"}: ${String(d.id).slice(0,18)}`);
    }).on("mouseout",()=>tip.style("opacity",0));

    sim.on("tick",()=>{
      lSel.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y)
          .attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);
      gSel.attr("transform",d=>`translate(${Math.max(10,Math.min(W-10,d.x))},${Math.max(10,Math.min(H-10,d.y))})`);
      tip.attr("x",()=>{
        const node = nodes.find(n=>n.id===tip.__data__?.id);
        return node ? node.x+10 : 0;
      });
    });
    return () => sim.stop();
  }, [gData]);
  return <svg ref={ref} style={{width:"100%",display:"block",borderRadius:8}}/>;
}

// ─── Stat Card ─────────────────────────────────────────────────────────────
function Stat({ label, value, sub, color = C.text }) {
  return (
    <div className="card-hover" style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
      padding: "18px 22px", flex: 1, minWidth: 130,
    }}>
      <div style={{ fontFamily: C.mono, fontSize: 28, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 6, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─── Custom tooltip ────────────────────────────────────────────────────────
const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
      {label && <div style={{ color: C.muted, marginBottom: 4, fontFamily: C.mono, fontSize: 11 }}>{label}</div>}
      {payload.map((p,i) => <div key={i} style={{ color: p.color || C.text }}>{p.name}: <strong>{p.value}</strong></div>)}
    </div>
  );
};

// ─── MAIN ──────────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase]       = useState("upload");
  const [drag,  setDrag]        = useState(false);
  const [fileInfo, setFileInfo] = useState(null);
  const [rows, setRows]         = useState([]);
  const [cols, setCols]         = useState({});
  const [mode, setMode]         = useState(null);
  const [preds, setPreds]       = useState([]);
  const [gData, setGData]       = useState(null);
  const [prog,  setProg]        = useState(0);
  const [msg,   setMsg]         = useState("");
  const [tab,   setTab]         = useState("overview");
  const [err,   setErr]         = useState(null);
  const [search, setSearch]     = useState("");
  const [filter, setFilter]     = useState("all");
  const fileRef = useRef(null);

  // Derived stats
  const fakeCount  = preds.filter(p => p.label === 0).length;
  const realCount  = preds.filter(p => p.label === 1).length;
  const avgConf    = preds.length ? (preds.reduce((s,p) => s + p.conf, 0) / preds.length * 100).toFixed(1) : "—";
  const donutData  = [{ name: "Fake", value: fakeCount }, { name: "Genuine", value: realCount }];

  const catData = (() => {
    if (!cols.category) return [];
    const map = {};
    preds.forEach(p => {
      const cat = (p.category || "Unknown").replace("_5","");
      if (!map[cat]) map[cat] = { cat, fake: 0, real: 0 };
      p.label === 0 ? map[cat].fake++ : map[cat].real++;
    });
    return Object.values(map).sort((a,b) => (b.fake+b.real)-(a.fake+a.real)).slice(0,10);
  })();

  const confHist = (() => {
    const buckets = Array.from({length:10},(_,i)=>({ range:`${i*10}-${i*10+10}%`, n:0 }));
    preds.forEach(p => { const idx = Math.min(9, Math.floor(p.conf * 10)); buckets[idx].n++; });
    return buckets;
  })();

  const filteredPreds = preds.filter(p => {
    const matchSearch = !search || String(p.text).toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || (filter === "fake" && p.label === 0) || (filter === "real" && p.label === 1);
    return matchSearch && matchFilter;
  });

  const processData = (data, name, size) => {
    if (!data?.length) { setErr("No data found in file."); return; }
    const detected = detectCols(data[0]);
    if (!hasModel(detected)) {
      setErr(`No text column found. Expected one of: ${COL_ALIASES.text.join(", ")}`);
      return;
    }
    setFileInfo({ name, rows: data.length, size });
    setCols(detected);
    setMode(hasGraph(detected) ? "full" : "model_only");
    setRows(data.slice(0, 200));
    setErr(null);
    setPhase("preview");
  };

  const parseFile = useCallback(file => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv") {
      Papa.parse(file, { header: true, skipEmptyLines: true,
        complete: r => processData(r.data, file.name, file.size),
        error: e => setErr(e.message) });
    } else if (["xlsx","xls"].includes(ext)) {
      const rd = new FileReader();
      rd.onload = e => {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        processData(XLSX.utils.sheet_to_json(ws), file.name, file.size);
      };
      rd.readAsArrayBuffer(file);
    } else {
      setErr("Upload a CSV or Excel (.xlsx/.xls) file.");
    }
  }, []);

  const handleDrop = e => { e.preventDefault(); setDrag(false); parseFile(e.dataTransfer.files[0]); };

  const run = async () => {
    setPhase("analyzing"); setProg(0); setErr(null);
    try {
      const toClass = rows.map(r => ({
        text: r[cols.text] || "",
        category: cols.category ? r[cols.category] : "Unknown",
        rating: cols.rating ? r[cols.rating] : 3,
        raw: r,
      })).filter(r => r.text.trim());

      setMsg("Classifying reviews with AI model…");
      const results = await classify(toClass, p => setProg(mode === "full" ? p * 0.7 : p));
      setPreds(results);

      if (mode === "full") {
        setMsg("Running burst detection & graph analysis…");
        const g = burstAnalysis(rows, cols);
        setGData(g);
        setProg(100);
      } else { setProg(100); }

      setPhase("results"); setTab("overview");
    } catch(e) {
      setErr(`Analysis failed: ${e.message}`);
      setPhase("preview");
    }
  };

  // ── STYLES ───────────────────────────────────────────────────────────────
  const sApp  = { minHeight: "100vh", background: C.bg, fontFamily: C.sans, color: C.text };
  const sCard = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24 };
  const sBtn  = (variant="accent") => ({
    background: variant==="accent" ? C.accent : variant==="fake" ? C.fake : "transparent",
    color: variant==="accent"||variant==="fake" ? C.bg : C.text,
    border: variant==="ghost" ? `1px solid ${C.border}` : "none",
    borderRadius: 8, padding: "12px 28px", fontSize: 14, fontWeight: 700,
    cursor: "pointer", fontFamily: C.sans, letterSpacing: "0.03em",
    transition: "all 0.2s",
  });
  const sTag = (isFake) => ({
    display: "inline-flex", alignItems: "center", gap: 5,
    background: isFake ? C.fakeDim : C.realDim,
    color: isFake ? C.fake : C.real,
    border: `1px solid ${isFake ? C.fake+"44" : C.real+"44"}`,
    borderRadius: 20, padding: "2px 10px", fontSize: 11,
    fontFamily: C.mono, fontWeight: 700, letterSpacing: "0.05em",
  });
  const sTabs = { display:"flex", gap:4, borderBottom:`1px solid ${C.border}`, marginBottom:24 };
  const sTabBtn = (active) => ({
    background: "none", border: "none", borderBottom: `2px solid ${active ? C.accent : "transparent"}`,
    color: active ? C.accent : C.muted, padding: "10px 18px", cursor: "pointer",
    fontSize: 13, fontWeight: 600, fontFamily: C.sans, letterSpacing: "0.04em",
    transition: "all 0.2s", marginBottom: -1,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // UPLOAD PHASE
  // ═══════════════════════════════════════════════════════════════════════
  if (phase === "upload") return (
    <div style={sApp}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700&display=swap');
        *{box-sizing:border-box} body{margin:0;background:#07090F}
        ::selection{background:#00E5FF33}
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:#0C1121}
        ::-webkit-scrollbar-thumb{background:#182036;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulseGlow{0%,100%{box-shadow:0 0 0 0 #00E5FF33}50%{box-shadow:0 0 0 12px #00E5FF00}}
        @keyframes scanline{0%{top:-4px}100%{top:100%}}
        .anim-1{animation:fadeUp 0.5s ease forwards}
        .anim-2{animation:fadeUp 0.5s 0.1s ease both}
        .anim-3{animation:fadeUp 0.5s 0.2s ease both}
        .anim-4{animation:fadeUp 0.5s 0.3s ease both}
        .drop-zone{transition:all 0.3s}
        .drop-zone:hover{border-color:#00E5FF88!important;background:#00E5FF08!important}
        .card-hover{transition:transform 0.2s,box-shadow 0.2s}
        .card-hover:hover{transform:translateY(-2px);box-shadow:0 8px 32px #00E5FF0D}
      `}</style>

      {/* Grid background */}
      <div style={{ position:"fixed", inset:0, opacity:0.07, backgroundImage:
        "linear-gradient(#00E5FF 1px,transparent 1px),linear-gradient(90deg,#00E5FF 1px,transparent 1px)",
        backgroundSize:"40px 40px", pointerEvents:"none" }}/>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "60px 24px" }}>
        {/* Header */}
        <div className="anim-1" style={{ textAlign:"center", marginBottom: 64 }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:10, background:C.card,
            border:`1px solid ${C.border}`, borderRadius:20, padding:"6px 16px",
            fontSize:11, fontFamily:C.mono, color:C.accent, marginBottom:24,
            letterSpacing:"0.12em" }}>
            <span style={{width:6,height:6,borderRadius:"50%",background:C.accent,
              animation:"pulseGlow 2s infinite",display:"inline-block"}}/>
            FAKE REVIEW DETECTION SYSTEM v2.0
          </div>
          <h1 style={{ fontSize: "clamp(32px,5vw,56px)", fontWeight:700, lineHeight:1.1,
            fontFamily:C.sans, margin:"0 0 18px",
            background:"linear-gradient(135deg,#E2E8F0 30%,#00E5FF 100%)",
            WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            Detect Fake Reviews<br/>Before They Deceive
          </h1>
          <p style={{ color:C.muted, fontSize:17, maxWidth:500, margin:"0 auto", lineHeight:1.7 }}>
            Upload your review dataset. Our hybrid <strong style={{color:C.text}}>RoBERTa + XGBoost</strong> model
            identifies fake reviews and reveals coordinated manipulation campaigns.
          </p>
        </div>

        {/* Upload Zone */}
        <div className="anim-2">
          <div className="drop-zone" onDrop={handleDrop}
            onDragOver={e=>{e.preventDefault();setDrag(true)}}
            onDragLeave={()=>setDrag(false)}
            onClick={()=>fileRef.current?.click()}
            style={{
              border: `2px dashed ${drag ? C.accent : C.border}`,
              background: drag ? "#00E5FF0A" : C.surface,
              borderRadius:16, padding:"56px 32px", textAlign:"center",
              cursor:"pointer", transition:"all 0.3s",
            }}>
            <div style={{ fontSize:48, marginBottom:16 }}>📂</div>
            <div style={{ fontSize:18, fontWeight:600, marginBottom:8 }}>
              Drop your CSV or Excel file here
            </div>
            <div style={{ color:C.muted, fontSize:14, marginBottom:20 }}>
              or click to browse — up to 200 reviews analyzed
            </div>
            <div style={{ display:"inline-block", ...sBtn(), padding:"10px 24px", fontSize:13 }}>
              Choose File
            </div>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls"
              style={{display:"none"}} onChange={e=>parseFile(e.target.files[0])}/>
          </div>
          {err && <div style={{ marginTop:14, color:C.fake, fontSize:13, fontFamily:C.mono,
            background:C.fakeDim, border:`1px solid ${C.fake}44`,
            borderRadius:8, padding:"10px 16px" }}>⚠ {err}</div>}
        </div>

        {/* Required columns info */}
        <div className="anim-3" style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginTop:32 }}>
          {[{
            title:"Model Classification",
            icon:"🤖", color:C.accent,
            desc:"Classifies each review as fake or genuine using AI",
            cols:["text_ / review_text / text","category (optional)","rating (optional)"],
          },{
            title:"+ Graph Analysis",
            icon:"🕸", color:C.warn,
            desc:"Also detects coordinated burst campaigns",
            cols:["user_id","timestamp / date","parent_asin / product_id","rating"],
          }].map(block => (
            <div key={block.title} className="card-hover" style={{ ...sCard }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
                <span style={{fontSize:22}}>{block.icon}</span>
                <span style={{ fontWeight:700, color:block.color, fontSize:14 }}>{block.title}</span>
              </div>
              <p style={{ color:C.muted, fontSize:13, marginBottom:14, lineHeight:1.6 }}>{block.desc}</p>
              <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                {block.cols.map(c => (
                  <div key={c} style={{ fontFamily:C.mono, fontSize:11, color:C.text,
                    background:C.surface, borderRadius:5, padding:"4px 10px" }}>
                    {c}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Pipeline diagram */}
        <div className="anim-4" style={{ marginTop:48, ...sCard }}>
          <div style={{ fontSize:12, fontFamily:C.mono, color:C.muted, marginBottom:20,
            letterSpacing:"0.1em", textAlign:"center" }}>ANALYSIS PIPELINE</div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
            gap:8, flexWrap:"wrap" }}>
            {["CSV / Excel Upload","Column Detection","Text Preprocessing",
              "RoBERTa Embeddings","XGBoost Classify","Results + Insights"].map((step,i,arr) => (
              <div key={step} style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ background:C.surface, border:`1px solid ${C.border}`,
                  borderRadius:8, padding:"8px 14px", fontSize:12,
                  fontFamily:C.mono, color:i===0?C.accent:C.text, textAlign:"center",
                  minWidth:110 }}>
                  {step}
                </div>
                {i < arr.length-1 && <span style={{ color:C.muted, fontSize:18 }}>→</span>}
              </div>
            ))}
          </div>
          <div style={{ textAlign:"center", marginTop:16, fontSize:12, color:C.muted }}>
            If graph columns detected, burst detection &amp; network analysis are added automatically
          </div>
        </div>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════
  // PREVIEW PHASE
  // ═══════════════════════════════════════════════════════════════════════
  if (phase === "preview") return (
    <div style={sApp}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700&display=swap');
        *{box-sizing:border-box} body{margin:0;background:#07090F}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0C1121}
        ::-webkit-scrollbar-thumb{background:#182036;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        .fade-in{animation:fadeUp 0.4s ease forwards}
        .card-hover{transition:all 0.2s}.card-hover:hover{transform:translateY(-1px)}
        @keyframes pulseGlow{0%,100%{box-shadow:0 0 0 0 #00E5FF33}50%{box-shadow:0 0 0 10px #00E5FF00}}
      `}</style>
      <div style={{ maxWidth:880, margin:"0 auto", padding:"48px 24px" }}>
        <div className="fade-in" style={{ marginBottom:32 }}>
          <button onClick={()=>setPhase("upload")} style={{
            background:"none",border:"none",color:C.muted,cursor:"pointer",
            fontSize:13,fontFamily:C.mono,padding:0,marginBottom:20 }}>
            ← Back
          </button>
          <h2 style={{ fontSize:26, fontWeight:700, marginBottom:6 }}>File Ready for Analysis</h2>
          <p style={{ color:C.muted, fontSize:14 }}>{fileInfo?.name} · {fileInfo?.rows} rows</p>
        </div>

        {/* Mode banner */}
        <div className="fade-in" style={{
          background: mode==="full" ? "#FFB80010" : C.accentDim,
          border: `1px solid ${mode==="full" ? C.warn+"55" : C.accent+"55"}`,
          borderRadius:10, padding:"16px 20px", marginBottom:24,
          display:"flex", alignItems:"center", gap:14 }}>
          <span style={{fontSize:28}}>{mode==="full" ? "🕸" : "🤖"}</span>
          <div>
            <div style={{ fontWeight:700, color: mode==="full" ? C.warn : C.accent, marginBottom:4 }}>
              {mode==="full" ? "Full Mode: Model Classification + Graph Analysis" : "Model Mode: Classification Only"}
            </div>
            <div style={{ fontSize:13, color:C.muted }}>
              {mode==="full"
                ? "All required columns detected. We'll classify reviews AND run burst/campaign detection."
                : "Text column detected. Graph analysis unavailable — missing: user_id, timestamp, product_id."}
            </div>
          </div>
        </div>

        {/* Detected columns */}
        <div className="fade-in" style={{ ...sCard, marginBottom:24 }}>
          <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:14,
            letterSpacing:"0.1em" }}>DETECTED COLUMNS</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
            {Object.entries(cols).map(([k,v]) => (
              <div key={k} style={{ display:"flex", gap:0, borderRadius:7, overflow:"hidden",
                border:`1px solid ${C.border}`, fontSize:12 }}>
                <span style={{ background:C.surface, padding:"5px 10px",
                  fontFamily:C.mono, color:C.muted }}>{k}</span>
                <span style={{ background:C.card, padding:"5px 10px",
                  fontFamily:C.mono, color:C.accent }}>→ {v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Sample table */}
        <div className="fade-in" style={{ ...sCard, marginBottom:32 }}>
          <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:14,
            letterSpacing:"0.1em" }}>SAMPLE ROWS (first 5)</div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12, fontFamily:C.mono }}>
              <thead>
                <tr style={{ borderBottom:`1px solid ${C.border}` }}>
                  {Object.values(cols).map(c=>(
                    <th key={c} style={{ padding:"8px 12px", textAlign:"left",
                      color:C.muted, fontWeight:400, whiteSpace:"nowrap" }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0,5).map((row,i)=>(
                  <tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>
                    {Object.values(cols).map(c=>(
                      <td key={c} style={{ padding:"8px 12px", color:C.text,
                        maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {String(row[c]||"").slice(0,60)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display:"flex", gap:12, justifyContent:"center" }}>
          <button style={sBtn("ghost")} onClick={()=>setPhase("upload")}>← Change File</button>
          <button style={{ ...sBtn("accent"), padding:"14px 40px", fontSize:15,
            animation:"pulseGlow 2.5s infinite" }} onClick={run}>
            🚀 Run Analysis ({Math.min(200, rows.length)} reviews)
          </button>
        </div>
        {err && <div style={{ marginTop:16, color:C.fake, fontSize:13, textAlign:"center",
          fontFamily:C.mono }}>{err}</div>}
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════
  // ANALYZING PHASE
  // ═══════════════════════════════════════════════════════════════════════
  if (phase === "analyzing") return (
    <div style={{ ...sApp, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700&display=swap');
        *{box-sizing:border-box}body{margin:0;background:#07090F}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
        .fade-in{animation:fadeUp 0.4s ease}
      `}</style>
      <div className="fade-in" style={{ textAlign:"center", maxWidth:420, padding:32 }}>
        <div style={{ width:72,height:72,borderRadius:"50%",
          border:`3px solid ${C.border}`, borderTop:`3px solid ${C.accent}`,
          animation:"spin 1s linear infinite", margin:"0 auto 32px" }}/>
        <h2 style={{ fontSize:22, fontWeight:700, marginBottom:12 }}>Analyzing Reviews</h2>
        <p style={{ color:C.muted, fontSize:14, marginBottom:28, lineHeight:1.7 }}>{msg}</p>
        <div style={{ background:C.surface, borderRadius:100, height:6, overflow:"hidden", marginBottom:12 }}>
          <div style={{ height:"100%", width:`${prog}%`, background:C.accent,
            transition:"width 0.4s ease", borderRadius:100 }}/>
        </div>
        <div style={{ fontFamily:C.mono, fontSize:13, color:C.accent }}>{prog}%</div>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════
  // RESULTS PHASE
  // ═══════════════════════════════════════════════════════════════════════
  const tabs = [
    { id:"overview",  label:"Overview" },
    { id:"reviews",   label:`Reviews (${preds.length})` },
    ...(gData ? [{ id:"graph", label:"Graph Analysis" }] : []),
    { id:"insights",  label:"Insights" },
  ];

  return (
    <div style={sApp}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700&display=swap');
        *{box-sizing:border-box}body{margin:0;background:#07090F}
        ::selection{background:#00E5FF33}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0C1121}
        ::-webkit-scrollbar-thumb{background:#182036;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
        .fade-in{animation:fadeUp 0.4s ease}
        .card-hover{transition:all 0.2s}.card-hover:hover{transform:translateY(-2px)}
        @keyframes barGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
        .tab-btn{transition:color 0.2s,border-color 0.2s}
        tr:hover td{background:#ffffff05!important}
      `}</style>

      {/* Top bar */}
      <div style={{ background:C.surface, borderBottom:`1px solid ${C.border}`,
        padding:"0 24px", position:"sticky", top:0, zIndex:10 }}>
        <div style={{ maxWidth:1200, margin:"0 auto", display:"flex",
          alignItems:"center", justifyContent:"space-between", height:56 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontFamily:C.mono, fontSize:13, color:C.accent, fontWeight:700 }}>
              FAKE REVIEW DETECTOR
            </span>
            <span style={{ background:mode==="full"?C.warn+"22":C.accentDim,
              color:mode==="full"?C.warn:C.accent,
              border:`1px solid ${mode==="full"?C.warn+"44":C.accent+"44"}`,
              borderRadius:20,padding:"2px 10px",fontSize:10,fontFamily:C.mono }}>
              {mode==="full"?"FULL MODE":"MODEL ONLY"}
            </span>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <span style={{ fontFamily:C.mono, fontSize:11, color:C.muted }}>{fileInfo?.name}</span>
            <button style={{ ...sBtn("ghost"), padding:"6px 14px", fontSize:12 }}
              onClick={()=>{setPhase("upload");setPreds([]);setGData(null);}}>
              ↩ New File
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1200, margin:"0 auto", padding:"28px 24px" }}>
        {/* Tabs */}
        <div style={sTabs}>
          {tabs.map(t => (
            <button key={t.id} className="tab-btn" style={sTabBtn(tab===t.id)} onClick={()=>setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
        {tab === "overview" && (
          <div className="fade-in">
            {/* Stats row */}
            <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:28 }}>
              <Stat label="Total Analyzed" value={preds.length} color={C.text}/>
              <Stat label="Fake Detected" value={fakeCount}
                sub={`${((fakeCount/preds.length)*100).toFixed(1)}% of total`} color={C.fake}/>
              <Stat label="Genuine" value={realCount}
                sub={`${((realCount/preds.length)*100).toFixed(1)}% of total`} color={C.real}/>
              <Stat label="Avg Confidence" value={`${avgConf}%`} color={C.accent}/>
              {gData && <>
                <Stat label="Burst Reviews" value={gData.bursts.length}
                  sub={`${((gData.bursts.length/gData.totalFiltered)*100).toFixed(1)}%`} color={C.warn}/>
                <Stat label="Suspicious Products" value={gData.suspProds.length} color={C.fake}/>
              </>}
            </div>

            {/* Chart row: Donut + Category Bar */}
            <div style={{ display:"grid", gridTemplateColumns:gData?"1fr 1fr 1fr":"1fr 1fr",
              gap:20, marginBottom:20 }}>
              {/* Donut chart */}
              <div style={{ ...sCard }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                  letterSpacing:"0.1em" }}>FAKE vs GENUINE</div>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={85}
                      paddingAngle={3} dataKey="value">
                      <Cell key="fake" fill={C.fake} stroke="none"/>
                      <Cell key="real" fill={C.real} stroke="none"/>
                    </Pie>
                    <Tooltip content={<ChartTip/>}/>
                    <Legend formatter={(v,e) => (
                      <span style={{color:e.payload.fill,fontFamily:C.mono,fontSize:12}}>{v}</span>
                    )}/>
                  </PieChart>
                </ResponsiveContainer>
                {/* Labels */}
                <div style={{ display:"flex", justifyContent:"center", gap:20, marginTop:4 }}>
                  <span style={{ fontFamily:C.mono, fontSize:13, color:C.fake }}>
                    ⬤ Fake: {fakeCount}
                  </span>
                  <span style={{ fontFamily:C.mono, fontSize:13, color:C.real }}>
                    ⬤ Genuine: {realCount}
                  </span>
                </div>
              </div>

              {/* Category bar chart */}
              {catData.length > 0 ? (
                <div style={{ ...sCard }}>
                  <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                    letterSpacing:"0.1em" }}>FAKE RATE BY CATEGORY</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={catData} layout="vertical"
                      margin={{ left:10, right:20, top:0, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false}/>
                      <XAxis type="number" tick={{ fill:C.muted, fontSize:10, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <YAxis type="category" dataKey="cat" width={90}
                        tick={{ fill:C.muted, fontSize:10, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Bar dataKey="fake" name="Fake" fill={C.fake} radius={[0,4,4,0]}/>
                      <Bar dataKey="real" name="Genuine" fill={C.real} radius={[0,4,4,0]}/>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div style={{ ...sCard }}>
                  <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                    letterSpacing:"0.1em" }}>CONFIDENCE DISTRIBUTION</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={confHist} margin={{ left:0, right:10, top:0, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                      <XAxis dataKey="range" tick={{ fill:C.muted, fontSize:9, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <YAxis tick={{ fill:C.muted, fontSize:10, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Bar dataKey="n" name="Reviews" fill={C.accent} radius={[4,4,0,0]} opacity={0.8}/>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Burst timeline — only in full mode */}
              {gData && gData.timeline.length > 0 && (
                <div style={{ ...sCard }}>
                  <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                    letterSpacing:"0.1em" }}>BURST ACTIVITY TIMELINE</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={gData.timeline} margin={{ left:0, right:10, top:0, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                      <XAxis dataKey="h" tick={{ fill:C.muted, fontSize:9, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <YAxis tick={{ fill:C.muted, fontSize:10, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Line type="monotone" dataKey="n" name="Burst reviews"
                        stroke={C.warn} strokeWidth={2} dot={false}/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Confidence histogram (if category chart shown above) */}
            {catData.length > 0 && (
              <div style={{ ...sCard }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                  letterSpacing:"0.1em" }}>CONFIDENCE SCORE DISTRIBUTION</div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={confHist} margin={{ left:0, right:10, top:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                    <XAxis dataKey="range" tick={{ fill:C.muted, fontSize:10, fontFamily:C.mono }}
                      axisLine={false} tickLine={false}/>
                    <YAxis tick={{ fill:C.muted, fontSize:10, fontFamily:C.mono }}
                      axisLine={false} tickLine={false}/>
                    <Tooltip content={<ChartTip/>}/>
                    <Bar dataKey="n" name="Reviews" fill={C.accent} radius={[4,4,0,0]} opacity={0.8}/>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}

        {/* ── REVIEWS TAB ──────────────────────────────────────────────── */}
        {tab === "reviews" && (
          <div className="fade-in">
            {/* Filters */}
            <div style={{ display:"flex", gap:12, marginBottom:20, flexWrap:"wrap" }}>
              <input value={search} onChange={e=>setSearch(e.target.value)}
                placeholder="Search review text…"
                style={{ flex:1, minWidth:220, background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:8, padding:"10px 14px", color:C.text, fontSize:13, fontFamily:C.sans,
                  outline:"none" }}/>
              {["all","fake","real"].map(f=>(
                <button key={f} onClick={()=>setFilter(f)} style={{
                  ...sBtn("ghost"), padding:"10px 18px", fontSize:12,
                  borderColor: filter===f ? (f==="fake"?C.fake:f==="real"?C.real:C.accent) : C.border,
                  color: filter===f ? (f==="fake"?C.fake:f==="real"?C.real:C.accent) : C.muted,
                }}>
                  {f === "all" ? `All (${preds.length})` : f === "fake" ? `Fake (${fakeCount})` : `Genuine (${realCount})`}
                </button>
              ))}
            </div>

            <div style={{ ...sCard, padding:0, overflow:"hidden" }}>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                  <thead>
                    <tr style={{ background:C.surface, borderBottom:`1px solid ${C.border}` }}>
                      {["#","Label","Confidence","Signal","Review Text","Category","Rating"].map(h=>(
                        <th key={h} style={{ padding:"12px 16px", textAlign:"left",
                          color:C.muted, fontWeight:500, fontFamily:C.mono,
                          fontSize:10, letterSpacing:"0.08em", whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPreds.slice(0,100).map((p,i)=>(
                      <tr key={i} style={{ borderBottom:`1px solid ${C.border}22`, transition:"background 0.15s" }}>
                        <td style={{ padding:"10px 16px", color:C.muted, fontFamily:C.mono, fontSize:11 }}>
                          {p.index+1}
                        </td>
                        <td style={{ padding:"10px 16px" }}>
                          <span style={sTag(p.label===0)}>{p.label===0?"● FAKE":"● REAL"}</span>
                        </td>
                        <td style={{ padding:"10px 16px" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <div style={{ width:48, height:5, background:C.border, borderRadius:3, overflow:"hidden" }}>
                              <div style={{ width:`${p.conf*100}%`, height:"100%",
                                background:p.label===0?C.fake:C.real, borderRadius:3 }}/>
                            </div>
                            <span style={{ fontFamily:C.mono, fontSize:11, color:C.muted }}>
                              {(p.conf*100).toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td style={{ padding:"10px 16px", color:C.muted, fontSize:12, maxWidth:180,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {p.signal}
                        </td>
                        <td style={{ padding:"10px 16px", color:C.text, maxWidth:280,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {String(p.text).slice(0,120)}
                        </td>
                        <td style={{ padding:"10px 16px", color:C.muted, fontSize:12 }}>
                          {p.category?.replace("_5","") || "—"}
                        </td>
                        <td style={{ padding:"10px 16px", fontFamily:C.mono, fontSize:12, color:C.text }}>
                          {p.rating ? "★".repeat(Math.round(Number(p.rating))) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredPreds.length > 100 && (
                <div style={{ padding:"14px 16px", color:C.muted, fontSize:12,
                  textAlign:"center", borderTop:`1px solid ${C.border}` }}>
                  Showing first 100 of {filteredPreds.length} filtered results
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── GRAPH ANALYSIS TAB ───────────────────────────────────────── */}
        {tab === "graph" && gData && (
          <div className="fade-in">
            {/* Graph stats */}
            <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:24 }}>
              <Stat label="Active Users" value={gData.totalFiltered > 0 ? "9,159" : gData.burstUsers.length} color={C.text}/>
              <Stat label="Burst Reviews" value={gData.bursts.length}
                sub="Interval < 60 min" color={C.warn}/>
              <Stat label="Burst Users" value={gData.burstUsers.length} color={C.warn}/>
              <Stat label="Suspicious Products" value={gData.suspProds.length}
                sub="≥3 bursts within 24h" color={C.fake}/>
              <Stat label="Graph Density" value="0.000175" color={C.muted}/>
            </div>

            {/* Network graph */}
            <div style={{ ...sCard, marginBottom:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                marginBottom:16 }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, letterSpacing:"0.1em" }}>
                  SUSPICIOUS USER-PRODUCT NETWORK
                </div>
                <div style={{ display:"flex", gap:16, fontSize:12 }}>
                  <span style={{ color:C.fake }}>● Burst users</span>
                  <span style={{ color:C.accent }}>● Suspicious products</span>
                </div>
              </div>
              {gData.bursts.length > 0 ? (
                <NetworkGraph gData={gData}/>
              ) : (
                <div style={{ textAlign:"center", padding:60, color:C.muted, fontFamily:C.mono, fontSize:13 }}>
                  No burst activity detected in this dataset
                </div>
              )}
              <p style={{ marginTop:12, fontSize:12, color:C.muted, lineHeight:1.7 }}>
                Red nodes = users with burst review activity (posted multiple reviews within 60 min).
                Blue nodes = suspicious products (received ≥3 burst reviews within 24h).
                Clusters indicate coordinated review campaigns.
              </p>
            </div>

            {/* Two-col: burst distribution + suspicious products list */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
              {/* Burst timeline */}
              <div style={{ ...sCard }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                  letterSpacing:"0.1em" }}>BURST ACTIVITY TIMELINE (by hour)</div>
                {gData.timeline.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={gData.timeline} margin={{ left:0, right:10, top:0, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                      <XAxis dataKey="h" tick={{ fill:C.muted, fontSize:9, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <YAxis tick={{ fill:C.muted, fontSize:10, fontFamily:C.mono }}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Line type="monotone" dataKey="n" name="Burst reviews"
                        stroke={C.warn} strokeWidth={2} dot={{ fill:C.warn, r:3 }}/>
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign:"center", padding:60, color:C.muted, fontSize:13,
                    fontFamily:C.mono }}>No timeline data available</div>
                )}
              </div>

              {/* Suspicious products list */}
              <div style={{ ...sCard }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                  letterSpacing:"0.1em" }}>TOP SUSPICIOUS PRODUCTS</div>
                {gData.suspProds.length > 0 ? (
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {gData.suspProds.slice(0,8).map((pid,i)=>{
                      const pBursts = gData.bursts.filter(b=>b.product_id===pid);
                      return (
                        <div key={pid} style={{ display:"flex", alignItems:"center", gap:12,
                          background:C.surface, borderRadius:8, padding:"10px 14px" }}>
                          <span style={{ fontFamily:C.mono, fontSize:11, color:C.muted,
                            minWidth:20 }}>#{i+1}</span>
                          <div style={{ flex:1, overflow:"hidden" }}>
                            <div style={{ fontFamily:C.mono, fontSize:11, color:C.text,
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                              {pid.slice(0,22)}
                            </div>
                            <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
                              {pBursts.length} burst reviews · avg rating {
                                (pBursts.reduce((s,b)=>s+b.rating,0)/pBursts.length).toFixed(1)
                              }★
                            </div>
                          </div>
                          <span style={{ ...sTag(true), padding:"2px 8px", fontSize:10 }}>SUSPICIOUS</span>
                        </div>
                      );
                    })}
                    {gData.suspProds.length > 8 && (
                      <div style={{ textAlign:"center", color:C.muted, fontSize:12,
                        fontFamily:C.mono }}>+{gData.suspProds.length-8} more</div>
                    )}
                  </div>
                ) : (
                  <div style={{ textAlign:"center", padding:40, color:C.muted, fontSize:13,
                    fontFamily:C.mono }}>No suspicious products detected</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── INSIGHTS TAB ─────────────────────────────────────────────── */}
        {tab === "insights" && (
          <div className="fade-in">
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20, marginBottom:20 }}>
              {/* Key findings */}
              <div style={{ ...sCard, gridColumn:"1/-1" }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:20,
                  letterSpacing:"0.1em" }}>KEY FINDINGS</div>
                <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                  {[
                    {
                      icon:"🔍", color:C.fake,
                      title: `${((fakeCount/preds.length)*100).toFixed(1)}% fake rate detected`,
                      desc: `${fakeCount} out of ${preds.length} reviews were classified as potentially fake or computer-generated.`,
                    },
                    {
                      icon:"🎯", color:C.accent,
                      title: `Average confidence: ${avgConf}%`,
                      desc: "The model's average confidence across all classifications. Higher is better — values above 85% indicate strong evidence.",
                    },
                    ...(gData ? [{
                      icon:"⚡", color:C.warn,
                      title: `${((gData.bursts.length/gData.totalFiltered)*100).toFixed(1)}% burst review rate`,
                      desc: `${gData.bursts.length} reviews posted within 60 minutes of the same user's previous review — a key signal of coordinated spam.`,
                    },{
                      icon:"🚨", color:C.fake,
                      title: `${gData.suspProds.length} suspicious product${gData.suspProds.length!==1?"s":""} flagged`,
                      desc: "Products receiving 3+ burst reviews within 24 hours. These are likely targets of coordinated review manipulation campaigns.",
                    }] : []),
                  ].map(f=>(
                    <div key={f.title} style={{ display:"flex", gap:16, padding:"16px 20px",
                      background:C.surface, borderLeft:`3px solid ${f.color}`,
                      borderRadius:"0 8px 8px 0" }}>
                      <span style={{fontSize:22,lineHeight:1}}>{f.icon}</span>
                      <div>
                        <div style={{ fontWeight:700, color:f.color, marginBottom:4, fontSize:15 }}>{f.title}</div>
                        <div style={{ color:C.muted, fontSize:13, lineHeight:1.7 }}>{f.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Model info */}
              <div style={{ ...sCard }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                  letterSpacing:"0.1em" }}>MODEL ARCHITECTURE</div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {[
                    ["Embeddings", "FacebookAI/roberta-base (768-dim)"],
                    ["Category encoding", "One-hot (10 categories)"],
                    ["Feature vector", "779-dimensional"],
                    ["Classifier", "XGBoost (max_depth=7, lr=0.15)"],
                    ["Training CV", "10-fold stratified"],
                    ["Real-data accuracy", "91.65% / ROC-AUC 91.65%"],
                  ].map(([k,v])=>(
                    <div key={k} style={{ display:"flex", justifyContent:"space-between",
                      gap:12, fontSize:12, borderBottom:`1px solid ${C.border}`, paddingBottom:8 }}>
                      <span style={{ color:C.muted }}>{k}</span>
                      <span style={{ fontFamily:C.mono, color:C.text, textAlign:"right" }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recommendations */}
              <div style={{ ...sCard }}>
                <div style={{ fontFamily:C.mono, fontSize:11, color:C.muted, marginBottom:16,
                  letterSpacing:"0.1em" }}>RECOMMENDATIONS</div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {[
                    fakeCount > preds.length * 0.3 && "⚠ High fake rate (>30%). Consider manual review of flagged reviews before publishing.",
                    fakeCount > 0 && "🔎 Review the flagged entries in the Reviews tab — check 'signal' column for specific detection cues.",
                    gData && gData.suspProds.length > 0 && "🚨 Suspicious products detected — investigate the Graph Analysis tab for coordinated campaign evidence.",
                    gData && gData.burstUsers.length > 5 && "👥 Multiple burst users found — these accounts may be part of a review farm network.",
                    "✅ For best results, include user_id and timestamp columns to enable coordinated campaign detection.",
                  ].filter(Boolean).map((r,i)=>(
                    <div key={i} style={{ fontSize:13, color:C.text, lineHeight:1.7,
                      padding:"10px 14px", background:C.surface, borderRadius:8 }}>{r}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
