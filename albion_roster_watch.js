// albion_roster_watch.js
// Vigía de roster para Albion Online con estado en Upstash y avisos por Discord.
// Requiere Node 18+ (fetch nativo). Usa variables de entorno (no pongas secretos en el código).

/* =========================
   🔧 Variables de entorno
   ========================= */
const WEBHOOK = process.env.WEBHOOK;                        // URL de tu webhook de Discord
const GUILD_ID = process.env.GUILD_ID;                      // p.ej. hSiy40ggSK2SUzKFhDVZnw (Outlimits)
const MEMBERS_API = `https://gameinfo.albiononline.com/api/gameinfo/guilds/${GUILD_ID}/members`;

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;   // de Upstash Redis (REST)
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; // de Upstash Redis (REST)
const REDIS_KEY     = process.env.REDIS_KEY || "outlimits:members";

/* =========================
   🧩 Utilidades
   ========================= */
function assertEnv() {
  const missing = [];
  if (!WEBHOOK) missing.push("WEBHOOK");
  if (!GUILD_ID) missing.push("GUILD_ID");
  if (!UPSTASH_URL) missing.push("UPSTASH_REDIS_REST_URL");
  if (!UPSTASH_TOKEN) missing.push("UPSTASH_REDIS_REST_TOKEN");
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}

function toLines(arr) {
  return arr.map(m => `• **${m.Name}** \`(${m.Id.slice(0,6)})\``);
}

// Corta una lista de líneas en bloques que no excedan ~900 chars (bajo el límite de 1024 de Discord)
function chunkByLength(lines, maxLen = 900) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    const add = (line + "\n").length;
    if (current.length > 0 && length + add > maxLen) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += add;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function toSet(arr) { return new Set(arr.map(x => x.Id)); }
function toMap(arr) { return new Map(arr.map(x => [x.Id, x])); }

/* =========================
   🌐 API Albion
   ========================= */
async function fetchMembers() {
  const r = await fetch(MEMBERS_API, {
    headers: { "User-Agent": "Outlimits-Roster-Watcher/1.1" }
  });
  if (!r.ok) throw new Error(`Albion API ${r.status}`);
  const data = await r.json();
  // Normaliza a [{Id,Name}]
  return data.map(m => ({ Id: m.Id, Name: m.Name || "(sin nombre)" }));
}

/* =========================
   🗄️ Upstash Redis (REST)
   ========================= */
async function redisGetJSON(key) {
  const url = `${UPSTASH_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  if (!r.ok) throw new Error(`Redis GET ${r.status}`);
  const { result } = await r.json(); // string o null
  if (!result) return null;
  try { return JSON.parse(result); } catch { return null; }
}

async function redisSetJSON(key, obj) {
  const payload = encodeURIComponent(JSON.stringify(obj));
  const url = `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${payload}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  if (!r.ok) throw new Error(`Redis SET ${r.status}`);
}

/* =========================
   💌 Discord (Embeds con troceo)
   ========================= */
function buildEmbeds(altas, bajas) {
  const embeds = [];

  const section = (titulo, arr) => {
    if (!arr.length) {
      embeds.push({
        title: "📜 Cambios en Outlimits",
        color: 0xDEB640,
        fields: [{ name: titulo, value: "Nadie" }],
        footer: { text: new Date().toLocaleString() }
      });
      return;
    }
    const lines  = toLines(arr);
    const chunks = chunkByLength(lines); // cada chunk será un field

    let i = 0;
    while (i < chunks.length) {
      const fields = [];
      // hasta 3 fields por embed para ir holgados
      for (let k = 0; k < 3 && i < chunks.length; k++, i++) {
        fields.push({
          name: k === 0 ? titulo : `${titulo} (cont.)`,
          value: chunks[i].join("\n")
        });
      }
      embeds.push({
        title: "📜 Cambios en Outlimits",
        color: 0xDEB640,
        fields,
        footer: { text: new Date().toLocaleString() }
      });
    }
  };

  section("➕ Ingresaron", altas);
  section("➖ Salieron", bajas);

  return embeds;
}

async function sendDiscordEmbeds({ altas, bajas }) {
  const embeds = buildEmbeds(altas, bajas);

  // Discord: máx 10 embeds por mensaje → enviamos en lotes de 10
  for (let i = 0; i < embeds.length; i += 10) {
    const slice = embeds.slice(i, i + 10);
    const r = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: slice })
    });
    if (!r.ok) {
      throw new Error(`Webhook ${r.status}: ${await r.text().catch(() => "")}`);
    }
  }
}

/* =========================
   🧠 Lógica principal
   ========================= */
async function main() {
  assertEnv();

  const current = await fetchMembers();               // [{Id,Name}]
  const prev    = (await redisGetJSON(REDIS_KEY)) || []; // snapshot previo o []

  const prevIds = toSet(prev);
  const currIds = toSet(current);

  const altasIds = [...currIds].filter(id => !prevIds.has(id));
  const bajasIds = [...prevIds].filter(id => !currIds.has(id));

  const currMap = toMap(current);
  const prevMap = toMap(prev);

  const altas = altasIds.map(id => currMap.get(id)).filter(Boolean);
  const bajas = bajasIds.map(id => prevMap.get(id) || ({ Id: id, Name: "(desconocido)" }));

  // Guarda snapshot actual (aunque falle Discord, ya tendremos estado para la siguiente)
  await redisSetJSON(REDIS_KEY, current);

  if (altas.length || bajas.length) {
    await sendDiscordEmbeds({ altas, bajas });
    console.log(`[OK] Reporte enviado. Altas: ${altas.length}, Bajas: ${bajas.length}`);
  } else {
    console.log("[OK] Sin cambios en el roster.");
  }
}

/* =========================
   ▶️ Ejecutar
   ========================= */
main().catch(err => {
  console.error("[ERROR]", err.message);
  process.exit(1);
});
