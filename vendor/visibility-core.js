function f(t){return!!t&&typeof t=="object"&&!Array.isArray(t)}function w(t){return Array.isArray(t)?t:[]}function h(t){return typeof t=="string"&&t.length>0?t:void 0}function k(t){return typeof t=="number"&&Number.isFinite(t)?t:0}function W(t){try{let n=new URL(t);n.hash="",n.searchParams.delete("utm_source");let e=n.toString();return e.endsWith("/")&&(e=e.slice(0,-1)),e.toLowerCase()}catch{return t.trim().toLowerCase()}}var A=class{list=[];index=new Map;add(n,e){if(!n)return null;let r=W(n),o=this.index.get(r);if(o!==void 0){let i=this.list[o];return!i.title&&e&&(i.title=e),o+1}return this.list.push(e?{url:n,title:e}:{url:n}),this.index.set(r,this.list.length-1),this.list.length}get citations(){return this.list}};function S(t){return Array.from(new Set(t)).sort((e,r)=>e-r).map(e=>` [${e}]`).join("")}function E(t){let n=f(t)?t:{},e=new A,r=[],o=0;for(let a of w(n.output))if(f(a)){if(a.type==="web_search_call"){o+=1;continue}if(a.type==="message")for(let p of w(a.content)){if(!f(p)||p.type!=="output_text")continue;let u=typeof p.text=="string"?p.text:"",l=[];for(let c of w(p.annotations)){if(!f(c)||c.type!=="url_citation")continue;let m=h(c.url),g=e.add(m,h(c.title));if(g===null||!m)continue;let d=G(u,c,m);d!==null&&l.push({at:d,n:g})}r.push(F(u,l))}}let i=r.join(`

`).trim();!i&&typeof n.output_text=="string"&&(i=n.output_text.trim());let s=f(n.usage)?n.usage:{};return{text:i,citations:e.citations,inputTokens:k(s.input_tokens),outputTokens:k(s.output_tokens),searchCalls:o}}function G(t,n,e){let r=typeof n.start_index=="number"?n.start_index:null,o=typeof n.end_index=="number"?n.end_index:null,i="";try{i=new URL(e).hostname.replace(/^www\./,"")}catch{}if(r!==null&&o!==null&&o<=t.length&&r<o){let p=t.slice(r,o);if(p.includes(e)||i&&p.includes(i))return o}let s=t.indexOf(e);if(s===-1)return null;let a=s+e.length;for(;a<t.length&&t[a]===")";)a+=1;return a}function F(t,n){if(n.length===0)return t;let e=new Map;for(let{at:o,n:i}of n)e.set(o,[...e.get(o)??[],i]);let r=t;for(let o of Array.from(e.keys()).sort((i,s)=>s-i))r=r.slice(0,o)+S(e.get(o))+r.slice(o);return r}function T(t){let n=f(t)?t:{},e=new A,r=w(n.content).filter(f),o="",i=0;for(let u of r){if(u.type==="server_tool_use"&&u.name==="web_search"&&(i+=1),u.type!=="text")continue;let l=typeof u.text=="string"?u.text:"",c=[];for(let m of w(u.citations)){if(!f(m)||m.type!==void 0&&m.type!=="web_search_result_location")continue;let g=e.add(h(m.url),h(m.title));g!==null&&c.push(g)}o+=c.length>0?J(l,S(c)):l}for(let u of r)if(u.type==="web_search_tool_result")for(let l of w(u.content))f(l)&&(l.type!==void 0&&l.type!=="web_search_result"||e.add(h(l.url),h(l.title)));let s=f(n.usage)?n.usage:{},a=f(s.server_tool_use)?s.server_tool_use:{},p=k(a.web_search_requests);return{text:o.trim(),citations:e.citations,inputTokens:k(s.input_tokens),outputTokens:k(s.output_tokens),searchCalls:p>0?p:i}}function J(t,n){let e=/\s*$/.exec(t),r=e?e.index:t.length;return t.slice(0,r)+n+t.slice(r)}function O(t){let n=new A,e=f(t.groundingMetadata)?t.groundingMetadata:{},r=[];for(let s of w(e.groundingChunks)){let a=f(s)&&f(s.web)?s.web:f(s)&&f(s.retrievedContext)?s.retrievedContext:null;r.push(a?n.add(h(a.uri),h(a.title)):null)}for(let s of t.sources??[])n.add(h(s?.url),h(s?.title));let o=t.text;for(let s of w(e.groundingSupports)){if(!f(s))continue;let a=f(s.segment)?s.segment:{},p=h(a.text)??h(s.segment_text);if(!p)continue;let u=w(s.groundingChunkIndices).map(m=>typeof m=="number"?r[m]:null).filter(m=>typeof m=="number");if(u.length===0)continue;let l=o.indexOf(p);if(l===-1)continue;let c=l+p.length;o=o.slice(0,c)+S(u)+o.slice(c)}let i=w(e.webSearchQueries).length;return{text:o,citations:n.citations,searchCalls:i>0||n.citations.length>0?1:0}}var R=["chatgpt","claude","gemini","perplexity"],$={chatgpt:{model:"chatgpt",env:["OPENAI_API_KEY"],modelId:"gpt-4.1",estimateUsd:.035},claude:{model:"claude",env:["ANTHROPIC_API_KEY"],modelId:"claude-haiku-5-5",estimateUsd:.015},gemini:{model:"gemini",env:["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY"],modelId:"gemini-2.5-flash",estimateUsd:.04},perplexity:{model:"perplexity",env:["PERPLEXITY_API_KEY"],modelId:"sonar",estimateUsd:.008}},B=[{model:"chatgpt",modelId:"gpt-4.1-mini",estimateUsd:.001},{model:"gemini",modelId:"gemini-2.5-flash",estimateUsd:.001},{model:"claude",modelId:"claude-haiku-5-5",estimateUsd:.002}];function j(t,n){for(let e of $[t].env)if(n[e]?.trim())return n[e].trim()}function nt(t,n=R){return n.filter(e=>j(e,t))}function D(t){for(let n of B){let e=j(n.model,t);if(e)return{...n,key:e}}return null}function st(t,n,e){let r=D(e),o=n.reduce((i,s)=>i+$[s].estimateUsd+(r?.estimateUsd??0),0);return Math.round(t*o*100)/100}var Y=t=>new Promise(n=>setTimeout(n,t));async function b(t,n,e,r,o=12e4){let i="";for(let s=0;s<4;s++){let a=await t(n,{method:"POST",headers:{"content-type":"application/json",...e},body:JSON.stringify(r),signal:AbortSignal.timeout(o)}),p=await a.text();if(a.ok)return JSON.parse(p);if(i=`${a.status} ${q(p)}`,a.status!==429&&a.status<500)break;let u=Number(a.headers.get("retry-after"));await Y(Number.isFinite(u)&&u>0?Math.min(u*1e3,3e4):2e3*2**s)}throw new Error(i)}function q(t){try{let n=JSON.parse(t),e=Array.isArray(n)?n[0]?.error:n.error;return(typeof e=="string"?e:e?.message)??t.slice(0,200)}catch{return t.slice(0,200)}}var H={"gpt-4.1":{in:2,out:8},"gpt-4.1-mini":{in:.4,out:1.6},"claude-haiku-5-5":{in:.1,out:.5},"gemini-2.5-flash":{in:.3,out:2.5},sonar:{in:1,out:1}},C={chatgpt:.025,claude:.01,gemini:.035,perplexity:.005},x=(t,n,e)=>{let r=H[t];return r?(n*r.in+e*r.out)/1e6:0};function K(t,n){return`You are a helpful assistant recommending mobile apps.
The user is in ${t.toUpperCase()} and writes in ${n.toUpperCase()}.
When the user asks for an app, return a short ranked list (1\u20135) of real,
currently-available apps. For each app: state its name first, then a
one-sentence reason. Prefer iOS App Store apps. Be specific \u2014 name the
exact app, not a category. If you genuinely cannot recommend any app,
say so plainly.`}function z(t){let n=t.toLowerCase();return["i can't recommend","i cannot recommend","i'm unable to recommend","i am unable to recommend"].some(e=>n.includes(e))||n.startsWith("i'm sorry")||n.startsWith("sorry, i")}var L=t=>/claude-[a-z]+-5/.test(t)?{max_tokens:16e3}:{max_tokens:1500,temperature:.4};async function ot(t,n,e,r=fetch){let o=$[t].modelId,i=K(e.country,e.language);try{let s="",a=[],p=0;if(t==="chatgpt"){let u=await b(r,"https://api.openai.com/v1/responses",{authorization:`Bearer ${n}`},{model:o,instructions:i,input:e.prompt,temperature:.4,tools:[{type:"web_search_preview",search_context_size:"low"}]}),l=E(u);({text:s,citations:a}=l),p=x(o,l.inputTokens,l.outputTokens)+C.chatgpt*Math.max(1,l.searchCalls)}else if(t==="claude"){let u=await b(r,"https://api.anthropic.com/v1/messages",{"x-api-key":n,"anthropic-version":"2023-06-01"},{model:o,...L(o),system:i,messages:[{role:"user",content:e.prompt}],tools:[{type:"web_search_20250305",name:"web_search",max_uses:3}]}),l=T(u);({text:s,citations:a}=l),p=x(o,l.inputTokens,l.outputTokens)+C.claude*Math.max(1,l.searchCalls)}else if(t==="gemini"){let u=await b(r,`https://generativelanguage.googleapis.com/v1beta/models/${o}:generateContent`,{"x-goog-api-key":n},{systemInstruction:{parts:[{text:i}]},contents:[{role:"user",parts:[{text:e.prompt}]}],tools:[{google_search:{}}],generationConfig:{temperature:.4}}),l=u?.candidates?.[0],c=(l?.content?.parts??[]).map(d=>d.text??"").join(""),m=O({text:c,groundingMetadata:l?.groundingMetadata});({text:s,citations:a}=m);let g=u?.usageMetadata??{};p=x(o,g.promptTokenCount??0,(g.candidatesTokenCount??0)+(g.thoughtsTokenCount??0))+(m.searchCalls>0?C.gemini:0)}else{let u=await b(r,"https://api.perplexity.ai/chat/completions",{authorization:`Bearer ${n}`},{model:o,temperature:.4,messages:[{role:"system",content:i},{role:"user",content:e.prompt}]});s=u?.choices?.[0]?.message?.content??"",a=(Array.isArray(u?.search_results)&&u.search_results.length?u.search_results:Array.isArray(u?.citations)?u.citations:[]).map(c=>typeof c=="string"?{url:c}:c&&typeof c.url=="string"?{url:c.url,title:c.title}:null).filter(c=>c!==null),p=x(o,u?.usage?.prompt_tokens??0,u?.usage?.completion_tokens??0)+C.perplexity}return{model:t,modelId:o,status:z(s)?"refusal":"ok",text:s,citations:a,costUsd:p}}catch(s){return{model:t,modelId:o,status:"error",text:"",citations:[],costUsd:0,error:s.message}}}function v(t){let n=t.indexOf("{"),e=t.lastIndexOf("}");if(n===-1||e<=n)throw new Error("no JSON in the answer");return JSON.parse(t.slice(n,e+1))}async function P(t,n,e,r=fetch){if(t.model==="chatgpt"){let s=await b(r,"https://api.openai.com/v1/chat/completions",{authorization:`Bearer ${t.key}`},{model:t.modelId,temperature:e,response_format:{type:"json_object"},messages:[{role:"user",content:n}]});return{json:v(s?.choices?.[0]?.message?.content??""),costUsd:x(t.modelId,s?.usage?.prompt_tokens??0,s?.usage?.completion_tokens??0)}}if(t.model==="gemini"){let s=await b(r,`https://generativelanguage.googleapis.com/v1beta/models/${t.modelId}:generateContent`,{"x-goog-api-key":t.key},{contents:[{role:"user",parts:[{text:n}]}],generationConfig:{temperature:e,responseMimeType:"application/json"}}),a=(s?.candidates?.[0]?.content?.parts??[]).map(u=>u.text??"").join(""),p=s?.usageMetadata??{};return{json:v(a),costUsd:x(t.modelId,p.promptTokenCount??0,(p.candidatesTokenCount??0)+(p.thoughtsTokenCount??0))}}let o=await b(r,"https://api.anthropic.com/v1/messages",{"x-api-key":t.key,"anthropic-version":"2023-06-01"},{model:t.modelId,...L(t.modelId),messages:[{role:"user",content:`${n}

Answer with the JSON object only.`}]}),i=(o?.content??[]).filter(s=>s.type==="text").map(s=>s.text).join("");return{json:v(i),costUsd:x(t.modelId,o?.usage?.input_tokens??0,o?.usage?.output_tokens??0)}}function V(t){let n=t.competitors.length?`
Known competitor apps: ${t.competitors.slice(0,10).join(", ")}`:"",e=t.citations.length?`

Citations available (0-indexed):
${t.citations.slice(0,10).map((r,o)=>`  [${o}] ${r.title??r.url}`).join(`
`)}`:"";return`You parse a recommendation answer from an AI assistant and extract
which mobile apps were mentioned, and in which position.

Original user prompt:
  """${t.prompt}"""

The user owns this app (recognise it even with minor spelling variants):
  "${t.owner}"${n}

Assistant's answer:
  """${t.answer.slice(0,8e3)}"""${e}

Return JSON: {"refusal": boolean, "apps": [{"appName": string, "position": number|null, "citationIndex": number|null}]}

Rules:
- "apps" lists each app the assistant mentioned in their recommendation,
  in the order the assistant presented them.
- position: 1-based rank when the assistant gave a numbered or ordered
  list. null when the answer is conversational prose with no clear ranking.
- citationIndex: if the assistant cited source [N] for that app, return
  N-1 (0-indexed into the Citations list above). null otherwise.
- If the assistant refused or said it couldn't recommend apps, set
  refusal=true and apps=[].
- Do NOT invent apps the assistant didn't mention. Do NOT include
  generic phrases like "an app for X" \u2014 only specific named apps.
- Strip explanatory parentheses from appName (return "Calm" not
  "Calm (popular meditation app)").
- App names should be the brand the assistant used.`}async function rt(t,n,e=fetch){let{json:r,costUsd:o}=await P(t,V(n),0,e),s=(Array.isArray(r?.apps)?r.apps:[]).map(a=>a).filter(a=>typeof a.appName=="string"&&a.appName.trim()).map(a=>({name:a.appName.trim(),position:typeof a.position=="number"&&a.position>=1?Math.round(a.position):null,citation:typeof a.citationIndex=="number"&&a.citationIndex>=0?Math.round(a.citationIndex):null}));return{refusal:!!r?.refusal,mentions:s,costUsd:o}}var _=t=>t.toLowerCase().replace(/[^\p{L}\p{N}]/gu,"");function N(t,n){let e=_(t);return e?n.some(r=>[r,r.split(/\s[:\-–—|]\s|:\s/)[0]??r].map(_).filter(i=>i.length>=3).some(i=>e===i||i.length>=4&&(e.includes(i)||i.includes(e)&&e.length>=i.length*.7))):!1}var X=25,I=t=>Math.round(t*10)/10;function it(t,n,e){return n.map(r=>{let o=t.filter(c=>c.intent===r&&(c.status==="ok"||c.status==="refusal")),i={};for(let c of R){let m=o.filter(y=>y.model===c);if(!m.length)continue;let g=m.map(y=>y.mentions.find(M=>N(M.name,e))).filter(y=>!!y),d=g.map(y=>y.position).filter(y=>y!==null);i[c]={pct:I(g.length/m.length*100),position:d.length?I(d.reduce((y,M)=>y+M,0)/d.length):null,prompts:m.length}}let s=Object.values(i),a=s.length?I(s.reduce((c,m)=>c+m.pct,0)/s.length):void 0,p=new Map;for(let c of o)for(let m of c.mentions){if(N(m.name,e))continue;let g=_(m.name),d=p.get(g)??{name:m.name,count:0,models:new Set};d.count++,d.models.add(c.model),p.set(g,d)}let u=[...p.values()].sort((c,m)=>m.count-c.count||c.name.localeCompare(m.name)).slice(0,5).map(c=>({name:c.name,pct:o.length?Math.min(100,I(c.count/o.length*100)):0,models:[...c.models]})),l=a===void 0?"no_data":a>=X?"winning":a>0?"weak":"missing";return{label:r,status:l,you:a,byModel:i,namedInstead:u}})}function at(t,n){let e=n.map(o=>o.toLowerCase().replace(/^www\./,"")),r=new Map;for(let o of t)for(let i of o.citations){let s;try{s=new URL(i.url).hostname.toLowerCase().replace(/^www\./,"")}catch{continue}s.endsWith("vertexaisearch.cloud.google.com")&&i.title&&/^[\w.-]+\.[a-z]{2,}$/i.test(i.title)&&(s=i.title.toLowerCase().replace(/^www\./,""));let a=r.get(s)??{domain:s,count:0,url:i.url};a.count++,e.some(p=>s===p||s.endsWith(`.${p}`))&&(a.yours=!0),r.set(s,a)}return[...r.values()].sort((o,i)=>i.count-o.count||o.domain.localeCompare(i.domain))}function Q(t,n,e){return`You map a mobile app to the *user intents* it serves \u2014 the goals
real users would ask an AI assistant (like ChatGPT, Gemini, or
Perplexity) about. Each intent is a short user-meaningful goal,
NOT an app feature.

App: ${t.title}${t.subtitle?`
Subtitle: ${t.subtitle}`:""}${t.description?`
Description (first 700 chars): ${t.description.slice(0,700)}`:""}${t.keywords?.length?`
Target keywords: ${t.keywords.slice(0,20).join(", ")}`:""}

Country: ${t.country.toUpperCase()}
Language: ${t.language.toUpperCase()}${e.length?`

ALREADY DEFINED (do NOT propose duplicates or near-duplicates):
- ${e.slice(0,30).join(`
- `)}`:""}

Return JSON: {"intents": [{"label": string, "description": string}]}

Rules:
- Propose between 4 and ${n} distinct intents.
- Phrase each intent from the USER's point of view, in sentence-case,
  starting with a verb when natural ("Fall asleep faster and unwind"). 4\u201310 words.
- Each intent must be something a real user would type into an AI
  assistant \u2014 NOT marketing copy and NOT a literal feature name.
- Cover a healthy mix: core use-cases, related needs the app can satisfy,
  problem-driven goals, and at least one comparison/alternative angle when applicable.
- Write labels in the storefront's language.
- Description (1 sentence, max 200 chars): what kind of user has this
  intent and what they want the assistant to recommend.`}function Z(t,n,e){return`You write realistic prompts that everyday users would type into an
AI assistant (ChatGPT, Gemini, Perplexity) when looking for a mobile app.

Intent to cover:
  "${n.label}"${n.description?`
  ${n.description}`:""}

App context (the app whose visibility we're measuring):
  Title: ${t.title}${t.subtitle?`
  Subtitle: ${t.subtitle}`:""}${t.competitors?.length?`
Known competitor apps (use in comparison prompts where natural): ${t.competitors.slice(0,6).join(", ")}`:""}

Country: ${t.country.toUpperCase()}
Language: ${t.language.toUpperCase()}

Return JSON: {"prompts": [string]}

Rules:
- Produce ${e} prompts that cover the intent from different angles:
  a pure category query, a problem-first one ("I struggle with\u2026"),
  a scenario ("an app for my morning routine"), and where natural an
  "alternative to X" comparison. Never name the app being measured.
- Write the way a casual user types, in the storefront's language:
  conversational, lower-case is fine. Length 8\u201335 words.
- Do NOT mention that you're an AI or test prompts. No emojis.`}var U=t=>t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").split(/\s+/).filter(Boolean).sort().join(" ");async function ct(t,n,e={},r=fetch){let o=e.maxIntents??6,i=await P(t,Q(n,o,e.exclude??[]),.7,r),s=i.costUsd,a=new Set((e.exclude??[]).map(U)),p=[];for(let l of Array.isArray(i.json?.intents)?i.json.intents:[]){if(typeof l?.label!="string"||l.label.trim().length<4)continue;let c=U(l.label);if(!a.has(c)&&(a.add(c),p.push({label:l.label.trim(),description:typeof l.description=="string"?l.description.trim():void 0}),p.length>=o))break}let u=[];for(let l of p){let c=await P(t,Z(n,l,e.promptsPerIntent??4),.8,r);s+=c.costUsd;let m=_(n.title.split(/[:\-–—|]/)[0]??n.title),g=[...new Set((Array.isArray(c.json?.prompts)?c.json.prompts:[]).filter(d=>typeof d=="string"&&d.trim().length>=15).map(d=>d.trim()))].filter(d=>m.length<4||!_(d).includes(m)).slice(0,e.promptsPerIntent??4);g.length&&u.push({...l,prompts:g})}return{intents:u,costUsd:s}}export{R as MODELS,$ as PROVIDERS,X as WINNING_PCT,ot as ask,nt as availableModels,at as citedDomains,rt as extract,ct as generateIntents,D as helperFor,P as helperJson,N as isOwner,j as keyFor,st as quoteScan,it as score};
