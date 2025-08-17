// Node 18+ — vigía de roster con estado en Upstash (REST)
const WEBHOOK = process.env.WEBHOOK;
const GUILD_ID = process.env.GUILD_ID; // hSiy40ggSK2SUzKFhDVZnw
const MEMBERS_API = `https://gameinfo.albiononline.com/api/gameinfo/guilds/${GUILD_ID}/members`;

// Upstash Redis (REST)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = process.env.REDIS_KEY || "outlimits:members";

function formatList(arr){ return arr.length ? arr.map(m=>`• **${m.Name}** \`(${m.Id.slice(0,6)})\``).join("\n") : "Nadie"; }
async function fetchMembers(){
  const r = await fetch(MEMBERS_API,{headers:{ "User-Agent":"Outlimits-Roster-Watcher/1.0"}});
  if(!r.ok) throw new Error(`Albion API ${r.status}`);
  const data = await r.json();
  return data.map(m=>({Id:m.Id, Name:m.Name||"(sin nombre)"}));
}
async function redisGetJSON(k){
  const r=await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
  if(!r.ok) throw new Error(`Redis GET ${r.status}`);
  const {result}=await r.json(); if(!result) return null;
  try{return JSON.parse(result);}catch{return null;}
}
async function redisSetJSON(k,obj){
  const r=await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(k)}/${encodeURIComponent(JSON.stringify(obj))}`,{headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
  if(!r.ok) throw new Error(`Redis SET ${r.status}`);
}
async function sendDiscordEmbed({altas,bajas}){
  const embed={ title:"📜 Cambios en Outlimits", description:"Altas y bajas comparadas vs. último snapshot.", color:0xDEB640,
    fields:[{name:"➕ Ingresaron",value:formatList(altas)},{name:"➖ Salieron",value:formatList(bajas)}],
    footer:{text:new Date().toLocaleString()} };
  const r=await fetch(WEBHOOK,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({embeds:[embed]})});
  if(!r.ok) throw new Error(`Webhook ${r.status}: ${await r.text().catch(()=> "")}`);
}
const toSet=a=>new Set(a.map(x=>x.Id)); const toMap=a=>new Map(a.map(x=>[x.Id,x]));
async function main(){
  if(!WEBHOOK||!GUILD_ID||!UPSTASH_URL||!UPSTASH_TOKEN) throw new Error("Faltan variables de entorno.");
  const current=await fetchMembers();
  const prev=(await redisGetJSON(REDIS_KEY))||[];
  const altasIds=[...toSet(current)].filter(id=>!toSet(prev).has(id));
  const bajasIds=[...toSet(prev)].filter(id=>!toSet(current).has(id));
  const altas=altasIds.map(id=>toMap(current).get(id)).filter(Boolean);
  const bajas=bajasIds.map(id=>toMap(prev).get(id)||{Id:id,Name:"(desconocido)"});
  await redisSetJSON(REDIS_KEY,current);
  if(altas.length||bajas.length){ await sendDiscordEmbed({altas,bajas}); console.log(`[OK] Enviado. Altas:${altas.length} Bajas:${bajas.length}`);}
  else { console.log("[OK] Sin cambios en el roster."); }
}
main().catch(e=>{ console.error("[ERROR]",e.message); process.exit(1); });
