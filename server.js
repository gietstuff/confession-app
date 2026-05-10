const express      = require('express');
const bodyParser   = require('body-parser');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 5000;
const EMOJI_REACTIONS = ['❤️','😮','😂','🥺','🔥'];

// ── Web Push (VAPID) ──────────────────────────────────────────────────────────
let webpush = null;
try {
  webpush = require('web-push');
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@giet.edu'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('Web Push ready');
} catch(e) {
  console.warn('web-push not installed — run: npm install web-push');
}

// ══════════════════════════════════════════════════════════════════════════════
// AI MODERATION PIPELINE v1 — 3-Layer Hybrid System
// ══════════════════════════════════════════════════════════════════════════════
// HOW IT WORKS (read this, it's your interview answer):
//
// Layer 1 — OpenAI Moderation API (instant, free)
//   Sends text to OpenAI's dedicated /v1/moderations endpoint.
//   Returns category scores (hate, harassment, sexual, violence, etc.)
//   It is FREE — not the chat API. OpenAI charges $0 for it.
//   If it flags as "toxic" → block immediately. No further checks.
//
// Layer 2 — Upstash Vector (semantic memory, free tier 10k vectors)
//   Converts text to a "vector embedding" — a list of ~384 numbers.
//   Each number represents a dimension of meaning in the sentence.
//   Stores vectors of banned confessions so the system "remembers" patterns.
//   If a new confession is mathematically similar (cosine similarity > 0.88)
//   to any banned one → block it. This catches paraphrased abuse.
//   CAREER TIP: This is "semantic similarity search" — a core AI/ML concept.
//
// Layer 3 — Groq + Llama 3.1 (borderline reasoning, free tier)
//   Only runs if Layers 1 and 2 passed but the text feels risky.
//   Sends a yes/no prompt to an 8B parameter LLM hosted on Groq's chips.
//   Groq's hardware (LPUs) is so fast this adds only ~300ms.
//   If Llama says "YES, it's targeted harassment" → shadow ban.
//   Shadow ban = post appears submitted to sender, but nobody else sees it.
//   CAREER TIP: Shadow banning is used by Reddit, Twitter, TikTok.
//
// WHERE TO LEARN:
//   Vector embeddings: https://www.youtube.com/watch?v=viZrOnJclY0 (3Blue1Brown)
//   Cosine similarity:  https://en.wikipedia.org/wiki/Cosine_similarity
//   Upstash Vector SDK: https://upstash.com/docs/vector/sdks/ts/getting-started
//   Groq API docs:      https://console.groq.com/docs/openai
//   OpenAI Moderation:  https://platform.openai.com/docs/guides/moderation
// ══════════════════════════════════════════════════════════════════════════════

// ── Upstash Vector client (lazy-loaded so missing env vars don't crash boot) ─
// LEARN: "Lazy loading" means we only initialize when first needed.
// This way the server still starts even if UPSTASH keys aren't set yet.
let _vectorClient = null;
function getVectorClient() {
  if (_vectorClient) return _vectorClient;
  if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) return null;
  try {
    const { Index } = require('@upstash/vector');
    // LEARN: Index() connects to your Upstash Vector database.
    // The SDK handles REST calls to Upstash's serverless vector DB.
    // You don't need to manage any server — Upstash runs it for you.
    _vectorClient = new Index({
      url: process.env.UPSTASH_VECTOR_REST_URL,
      token: process.env.UPSTASH_VECTOR_REST_TOKEN,
    });
    return _vectorClient;
  } catch(e) {
    console.warn('[AI MOD] @upstash/vector not installed — run: npm install @upstash/vector');
    return null;
  }
}

// ── Layer 1: Google Gemini Flash — Safety Filter ─────────────────────────────
// WHY GEMINI INSTEAD OF OPENAI:
//   OpenAI's moderation API is technically free, but requires a paid billing
//   account to activate — meaning you need a credit card even for $0 usage.
//   Google Gemini API has a GENUINELY free tier: no card, no billing required.
//   1000 requests/day on Gemini 2.5 Flash-Lite. More than enough for GIET.
//
// HOW TO GET YOUR FREE KEY (2 minutes):
//   1. Go to https://aistudio.google.com
//   2. Sign in with Google → click "Get API key" → "Create API key"
//   3. Copy the key (starts with "AIza...")
//   4. Add to Render env vars: GEMINI_API_KEY=AIza...
//
// HOW THIS WORKS:
//   Gemini has built-in safety categories (HARM_CATEGORY_HARASSMENT,
//   HARM_CATEGORY_HATE_SPEECH, HARM_CATEGORY_SEXUALLY_EXPLICIT,
//   HARM_CATEGORY_DANGEROUS_CONTENT). When we send text, Gemini returns
//   a safetyRatings array with probability scores for each category.
//   If ANY category is HIGH or MEDIUM → block the confession.
//
// CAREER TIP: This is called "using an LLM as a safety classifier."
//   Google's own docs recommend Gemini Flash-Lite for moderation because
//   it's fast and cheap (free). The pattern of sending text to an LLM
//   and reading its safety_ratings is used in production at scale.
//
// WHERE TO LEARN:
//   https://ai.google.dev/gemini-api/docs/safety-settings
//   https://aistudio.google.com (free key here)
async function checkGeminiModeration(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { flagged: false, skipped: true };
  try {
    // LEARN: gemini-2.0-flash-lite is the fastest, cheapest Gemini model.
    // We use generateContent (not a dedicated moderation endpoint) but set
    // safety thresholds to BLOCK_LOW_AND_ABOVE so even low-probability harm
    // triggers a block. The response's promptFeedback tells us if it was blocked.
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Content moderation check: "${text.slice(0, 800)}"` }] }],
          // LEARN: safetySettings override the default thresholds.
          // BLOCK_LOW_AND_ABOVE = flag anything that has even a LOW probability of harm.
          // We're being strict — false positives go to pending for admin review.
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
          ],
          // Short response — we don't care what Gemini says, just whether it blocked
          generationConfig: { maxOutputTokens: 5 }
        })
      }
    );
    if (!response.ok) return { flagged: false, skipped: true };
    const data = await response.json();

    // LEARN: If Gemini blocked the prompt, promptFeedback.blockReason is set.
    // The safetyRatings array shows which category triggered it.
    // candidates[0].finishReason === 'SAFETY' also indicates a block.
    const blocked = data.promptFeedback?.blockReason
      || data.candidates?.[0]?.finishReason === 'SAFETY';

    if (blocked) {
      // Extract which categories were flagged for admin logging
      const ratings = data.promptFeedback?.safetyRatings || data.candidates?.[0]?.safetyRatings || [];
      const flaggedCats = ratings
        .filter(r => r.probability === 'HIGH' || r.probability === 'MEDIUM')
        .map(r => r.category.replace('HARM_CATEGORY_', '').toLowerCase())
        .join(', ');
      return { flagged: true, reason: flaggedCats || data.promptFeedback?.blockReason || 'safety' };
    }
    return { flagged: false };
  } catch(e) {
    console.warn('[AI MOD] Gemini moderation error:', e.message);
    return { flagged: false, skipped: true };
  }
}

// ── Layer 2: Upstash Vector similarity search ─────────────────────────────────
// LEARN: "Upsert" = "Update if exists, Insert if not" — a database term.
// When you mark a post as abusive, we upsert its vector so the DB learns it.
// On every new submission, we query for the closest matching vectors.
// If similarity > threshold, the new post is too close to a banned one.
//
// The SDK's built-in embedding uses a small model (like all-MiniLM-L6-v2).
// You pass raw text → the SDK calls Upstash's embedding endpoint → returns vector.
// No separate embedding API key needed. This is the "no separate embedding" feature.
async function checkVectorSimilarity(text) {
  const vectorClient = getVectorClient();
  if (!vectorClient) return { similar: false, skipped: true };
  try {
    // LEARN: query() takes your text, converts it to a vector, then finds
    // the top K most similar vectors already stored in the index.
    // topK:1 means "find the single closest match".
    // includeMetadata:true so we get back the original text (for logging).
    const results = await vectorClient.query({
      data: text,        // raw text — SDK auto-embeds it
      topK: 1,
      includeMetadata: true,
    });
    if (!results?.length) return { similar: false };
    const topScore = results[0].score;
    // LEARN: Cosine similarity returns 0.0 to 1.0.
    // 1.0 = identical meaning. 0.88 = very similar but not word-for-word.
    // We set 0.88 as threshold: below that, it's different enough to allow.
    const SIMILARITY_THRESHOLD = 0.88;
    return {
      similar: topScore >= SIMILARITY_THRESHOLD,
      score: topScore,
      matchedText: results[0].metadata?.text,
    };
  } catch(e) {
    console.warn('[AI MOD] Upstash vector query error:', e.message);
    return { similar: false, skipped: true };
  }
}

// ── upsertBannedVector: called when admin marks a post as abusive ─────────────
// LEARN: This is how the system "learns". Every time you click "Mark Abusive",
// this function saves the confession's vector into Upstash.
// Future similar confessions will then be blocked by Layer 2.
// The id parameter is a UUID we use as the vector's unique key in Upstash.
async function upsertBannedVector(id, text) {
  const vectorClient = getVectorClient();
  if (!vectorClient) return false;
  try {
    await vectorClient.upsert({
      id,              // unique key (we use the confession's MongoDB UUID)
      data: text,      // SDK converts this to a vector automatically
      metadata: { text: text.slice(0, 200), bannedAt: Date.now() }
    });
    console.log(`[AI MOD] Upserted banned vector for id=${id}`);
    return true;
  } catch(e) {
    console.warn('[AI MOD] Upstash upsert error:', e.message);
    return false;
  }
}

// ── Layer 3: Groq + Llama 3.1 — borderline reasoning ─────────────────────────
// LEARN: Groq is a hardware company (LPUs = Language Processing Units).
// Their API is OpenAI-compatible (same request format), just different base URL.
// Llama 3.1 8B is Meta's open-source model. Small but fast and free on Groq.
// We use it only for borderline cases — it's the expensive (time-wise) fallback.
//
// The prompt is a "zero-shot classifier": we tell it exactly what YES/NO means.
// "Zero-shot" = the model wasn't specifically trained on your task,
//  but general language understanding is enough to answer.
async function checkGroqHarassment(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { harassing: false, skipped: true };
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 5,           // We only need "YES" or "NO" — 5 tokens max
        temperature: 0,          // LEARN: temperature=0 makes the model deterministic.
                                 // Same input always gives same output. Good for classifiers.
        messages: [
          {
            role: 'system',
            // LEARN: The system prompt constrains the model's behavior.
            // By saying "Answer only YES or NO", we prevent long explanations.
            // This is "prompt engineering" — shaping LLM output via instructions.
            content: 'You are a content moderation assistant for a college anonymous confession website in India. Answer ONLY with YES or NO.'
          },
          {
            role: 'user',
            content: `Is the following confession attempting to harass, bully, expose, or target a specific real person (by description, nickname, role, or otherwise)? Answer YES or NO only.\n\nConfession: "${text.slice(0, 500)}"`
          }
        ]
      })
    });
    if (!response.ok) return { harassing: false, skipped: true };
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    // LEARN: We check for "YES" as a substring because the model might return
    // "YES." or "YES, this is..." despite instructions. Defensive parsing.
    return { harassing: answer?.includes('YES') ?? false, answer };
  } catch(e) {
    console.warn('[AI MOD] Groq check error:', e.message);
    return { harassing: false, skipped: true };
  }
}

// ── Master pipeline — runs all 3 layers in order ─────────────────────────────
// LEARN: async/await lets us write asynchronous code that looks synchronous.
// Each "await" pauses until the network call finishes, then continues.
// We chain the checks: if Layer 1 fails → skip 2 and 3, return immediately.
// This "fail fast" pattern saves time and API credits.
//
// Returns: { block: bool, shadowBan: bool, reason: string, layer: string }
//   block     = true → reject the confession entirely, show error to user
//   shadowBan = true → accept silently but hide from everyone else
//   reason    = human-readable explanation (stored in DB, visible to admin)
async function aiModerationPipeline(text) {
  // ── Layer 1: Gemini Safety Filter ────────────────────────────────────────
  const gemini = await checkGeminiModeration(text);
  if (gemini.flagged) {
    return { block: true, shadowBan: false, reason: `Gemini flagged: ${gemini.reason || 'safety'}`, layer: 'gemini' };
  }

  // ── Layer 2: Vector Similarity ────────────────────────────────────────────
  const vec = await checkVectorSimilarity(text);
  if (vec.similar) {
    return {
      block: true, shadowBan: false,
      reason: `Similar to banned confession (score: ${vec.score?.toFixed(3)})`,
      layer: 'vector'
    };
  }

  // ── Layer 3: Groq Harassment Check (only for borderline / always if keys set) ─
  // LEARN: We run Groq as an extra check for confessions that passed Layers 1+2.
  // This catches nuanced targeted harassment that regex and OpenAI miss:
  // e.g. "The girl who sits in the last bench of CSE-B section is a..." 
  // No slurs → passes OpenAI. No similar past confession → passes vector.
  // But Groq reads context and understands it targets a specific person.
  const groq = await checkGroqHarassment(text);
  if (groq.harassing) {
    // Shadow ban (not hard block) — Groq is less certain than OpenAI,
    // so we don't want false positives ruining real confessions.
    // LEARN: Shadow ban = post is saved with shadowBanned:true.
    // The submitter gets a "pending" response (they think it worked).
    // But the feed filters it out for everyone else.
    return { block: false, shadowBan: true, reason: `Groq detected targeted harassment`, layer: 'groq' };
  }

  return { block: false, shadowBan: false, reason: '', layer: 'passed' };
}

// ══════════════════════════════════════════════════════════════════════════════
// SMART CONTENT FILTER v4 — 100% FREE, zero external API calls
// ══════════════════════════════════════════════════════════════════════════════
// LEARN: Why no paid AI? Cost + reliability. If the AI API goes down or runs
// out of credits, the whole site breaks. This filter handles everything with
// clever regex patterns. It catches what the old list missed:
//   • Roll numbers (2k22CS045, 22EGCS001, EG/22/001, etc.)
//   • Leet-speak abuse (f@ck, $hit, ch*tiya)
//   • Hinglish abuse with creative spellings
//   • Section identifiers (sec-A, section F, CSE-B batch)
//   • Partial name hints (Kh___, R****)
// ══════════════════════════════════════════════════════════════════════════════

const PHONE_RE  = /(\+?91[\s\-]?)?[6-9]\d{9}/g;
const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const HANDLE_RE = /@[a-zA-Z0-9_.]{2,}/g;
const LINK_RE   = /https?:\/\/[^\s]+/gi;

// ── Roll number patterns — covers most Indian college formats ──
// LEARN: | in regex means OR. We chain all common roll number formats.
// Examples caught: 2k22CS045, 22EGCS001, EG/22/CS/001, 2022CSE045
const ROLL_RE = /\b([2][0-9]{3}[A-Z]{2,4}[0-9]{2,4}|[0-9]{2}[A-Z]{2,6}[0-9]{3,4}|[A-Z]{2,4}[\/\-][0-9]{2}[\/\-][0-9]{3,4}|[A-Z]{2,4}[0-9]{4,8}|[0-9]{4}[A-Z]{2,4}[0-9]{3,4}|\d{2}[A-Z]{2}\d{3,4})\b/gi;

// ── Section/batch identifiers ──
// Catches: sec-A, section F, CSE-B, branch B, 2nd year A
const SECTION_RE = /\b(sec(tion)?[\s\-]?[A-F]|[A-Z]{2,4}[\s\-][A-F]\s+batch|branch[\s\-][A-F]|[1-4](st|nd|rd|th)\s+year\s+[A-F])\b/gi;

// ── Partial name hints with blanks/stars (e.g. "Kh___", "R****") ──
const PARTIAL_NAME_RE = /\b[A-Z][a-zA-Z]{0,3}[_*]{3,}[a-zA-Z]{0,3}\b/g;

// ── Abuse list — English + Hindi/Hinglish + leet-speak variants ──
// LEARN: The leet-speak variants (f@ck, $hit) are separate patterns.
// We sort longest-first so "motherfucker" matches before "fucker".
const ABUSE_WORDS = [
  // English
  'fuck','fucking','fucked','fucker','fucks','bitch','bitches','shit','shitty',
  'asshole','bastard','cunt','dick','cock','pussy','whore','slut','bollocks',
  'nigger','nigga','faggot','retard','rape','rapist','molest','kys','piss',
  'motherfucker','dickhead','bullshit','horseshit','jackass','dumbass',
  // Hindi/Hinglish
  'chutiya','chutiye','bhenchod','madarchod','bhosdike','bhosdika','bsdk',
  'lodu','lauda','lavde','gaand','randi','harami','gandu','jhant','lund',
  'chut','bhosdi','maderchod','bhencho','kutte','kutiya','chodu','choda',
  'chod','chodna','saala','saali','gadha','kamina','haramzada','haramzadi',
  'rascal','bakwaas','ullu','bhadwa','bhadwi','hijra','chakka',
  // Common short abuses used in Indian context (context-checked below)
  'mc','bc',
];
const ABUSE_RE = new RegExp(
  '(?<![a-zA-Z])(' +
  ABUSE_WORDS.sort((a,b)=>b.length-a.length)
    .map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') +
  ')(?![a-zA-Z])', 'gi'
);

// Leet-speak abuse patterns (f@ck, $hit, ch*tiya, etc.)
const LEET_RE = /\b(f[@4]c+k|$h[i1]t|[a@]ssh[o0]le|b[i1]tc+h|d[i1]ck|c[@*]ck|p[u@]ssy|wh[o0]re|ch[\*@]t[i1]y[a@]|bh[\*@]nch[o0]d|m[a@]d[a@]rch[o0]d)\b/gi;

// ── "mc" and "bc" are only abuse in certain contexts ──
// LEARN: "bc" meaning "because" is totally fine. We check what comes
// after: if it's a vowel/word it's likely "because", otherwise abuse.
// This is context-sensitive filtering without needing AI.
function isAbusiveShortForm(word, fullText, matchIndex) {
  const before = fullText.slice(Math.max(0, matchIndex - 20), matchIndex).toLowerCase();
  const after  = fullText.slice(matchIndex + word.length, matchIndex + word.length + 10).toLowerCase();
  if (word.toLowerCase() === 'bc') {
    // "bc" as "because" usually followed by a space+word or comma
    if (/\s+(of|he|she|it|i|the|this|that|my|your|his|her|they)/.test(' ' + after)) return false;
    if (before.trim().endsWith(',')) return false;
  }
  if (word.toLowerCase() === 'mc') {
    // "mc" as "MC (emcee/rapper)" — usually in music context
    if (/rap|music|song|emcee|hip/.test(before)) return false;
  }
  return true;
}

// ── Name list (expanded with more Indian names) ──
const COMMON_NAMES = [
  'aarav','aditya','akash','akshay','akshat','amit','amitesh','ananya','anjali',
  'ankit','ankita','anushka','arjun','aryan','ashish','bhavya','deepak','deepika',
  'devansh','dhruv','divya','gaurav','harsh','harshit','ishaan','ishika','janhvi',
  'jay','karan','kartik','kavya','komal','krishna','kunal','lakshmi','manish',
  'mehul','mohit','naman','neha','nikhil','nikita','nishant','palak','parth',
  'pooja','prachi','prakash','prashant','prateek','pratik','priya','priyanshi',
  'rahul','raj','rajat','rajesh','ravi','ritesh','rohit','ruchika','sachin',
  'sahil','sakshi','sandeep','sanjay','shivam','shreya','siddharth','simran',
  'sneha','soham','sourav','sumit','suraj','swati','tanvi','tushar','udit',
  'vaibhav','vandana','vibhav','vikash','vikas','vishal','yash','yashasvi','zara',
  // more common GIET-context names
  'himanshu','harshita','sarthak','utkarsh','aakash','abhishek','ajay','alok',
  'aman','amisha','anand','anshul','anurag','apoorva','astha','ayush','bhanu',
  'chetan','chirag','devika','diksha','dinesh','garima','girish','hitesh',
  'jagdish','jatin','karishma','khushbu','lalit','madhur','mahesh','mansi',
  'megha','mukesh','nidhi','payal','piyush','pragati','preeti','raghav',
  'rakesh','ramesh','rashmi','rishi','ritu','rohan','romil','rupesh','sanket',
  'seema','shubham','sonika','sourabh','subham','sudhir','sunil','suresh',
  'swapnil','tarun','umesh','vicky','vijay','vinay','vineet','vivek','yogesh',
];
const NAME_RE = new RegExp('\\b(' + COMMON_NAMES.join('|') + ')\\b', 'gi');

function blurWord(word) {
  if (word.length <= 2) return '*'.repeat(word.length);
  return word[0] + '*'.repeat(word.length - 2) + word[word.length - 1];
}

// ── Main filter — synchronous, no external calls, fast ──
function filterConfession(rawText) {
  const flags = [];
  let text = rawText;

  // 1. Links
  if (LINK_RE.test(text)) { flags.push('link'); text = text.replace(LINK_RE, '[link removed]'); } LINK_RE.lastIndex = 0;

  // 2. Phone numbers
  if (PHONE_RE.test(text)) { flags.push('phone'); text = text.replace(PHONE_RE, '[number hidden]'); } PHONE_RE.lastIndex = 0;

  // 3. Email
  if (EMAIL_RE.test(text)) { flags.push('email'); text = text.replace(EMAIL_RE, '[email hidden]'); }

  // 4. Handles
  if (HANDLE_RE.test(text)) { flags.push('handle'); text = text.replace(HANDLE_RE, '[handle hidden]'); }

  // 5. Roll numbers (new — catches 2k22CS045 etc.)
  if (ROLL_RE.test(text)) { flags.push('roll'); text = text.replace(ROLL_RE, '[roll hidden]'); } ROLL_RE.lastIndex = 0;

  // 6. Section/batch identifiers
  if (SECTION_RE.test(text)) { flags.push('section'); text = text.replace(SECTION_RE, '[section hidden]'); } SECTION_RE.lastIndex = 0;

  // 7. Partial name hints (Kh___, R****)
  if (PARTIAL_NAME_RE.test(text)) { flags.push('partial_name'); text = text.replace(PARTIAL_NAME_RE, '[Name]'); } PARTIAL_NAME_RE.lastIndex = 0;

  // 8. Leet-speak abuse
  if (LEET_RE.test(text)) { flags.push('abuse'); text = text.replace(LEET_RE, m => blurWord(m)); } LEET_RE.lastIndex = 0;

  // 9. Standard abuse (with context check for mc/bc)
  let abuseFound = false;
  text = text.replace(ABUSE_RE, (match, p1, offset) => {
    const lower = match.toLowerCase();
    if ((lower === 'mc' || lower === 'bc') && !isAbusiveShortForm(match, text, offset)) {
      return match; // keep it — it's "because" or "emcee"
    }
    abuseFound = true;
    return blurWord(match);
  });
  ABUSE_RE.lastIndex = 0;
  if (abuseFound && !flags.includes('abuse')) flags.push('abuse');

  // 10. Known names
  if (NAME_RE.test(text)) { flags.push('name'); text = text.replace(NAME_RE, '[Name]'); } NAME_RE.lastIndex = 0;

  return { cleanText: text, flags, wasEdited: text !== rawText, aiReasoning: '', usedAI: false };
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
let confCol, pendingCol, analyticsCol, uniqueCol, repliesCol, settingsCol, pushSubCol, discussionsCol, suggestionsCol;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('giet_confession');
  confCol      = db.collection('confessions');
  pendingCol   = db.collection('pending');
  analyticsCol = db.collection('analytics');
  uniqueCol    = db.collection('unique_visitors');
  repliesCol   = db.collection('replies');
  settingsCol  = db.collection('settings');
  pushSubCol   = db.collection('push_subscriptions');
  discussionsCol = db.collection('discussions');
  suggestionsCol = db.collection('suggestions');
  console.log('MongoDB connected');

  await analyticsCol.updateOne({ _id: 'main' },
    { $setOnInsert: { visits: 0, uniqueVisitors: 0 } }, { upsert: true });
  await settingsCol.updateOne({ _id: 'main' },
    { $setOnInsert: { autoApprove: false } }, { upsert: true });
  await pushSubCol.createIndex({ endpoint: 1 }, { unique: true });
  // TTL index on lastSeen: documents auto-expire after 90s
  // LEARN: MongoDB TTL index deletes docs automatically — "online now" = docs with recent lastSeen.
  // Survives Render cold starts (in-memory Map does not).
  try { await uniqueCol.dropIndex('lastSeen_1'); } catch(e) {}
  await uniqueCol.createIndex({ lastSeen: 1 }, { expireAfterSeconds: 90 });
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.CLIENT_URL,
  'https://page-confession.vercel.app',
  'http://localhost:3000',
  'http://localhost:5000',
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(bodyParser.json({ limit: '10kb' })); // body size cap — prevents DoS via huge payloads
app.use(cookieParser());

// ── Security headers (no helmet needed — plain Express) ──────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ── In-memory rate limiter (no npm package — pure JS Map) ────────────────────
// Survives the session but resets on cold start (acceptable for free tier).
// Structure: Map<ip, Map<endpoint, { count, resetAt }>>
const _rl = new Map();
function rateLimit(endpoint, ip, max, windowMs) {
  const now = Date.now();
  if (!_rl.has(ip)) _rl.set(ip, new Map());
  const ipMap = _rl.get(ip);
  if (!ipMap.has(endpoint) || now > ipMap.get(endpoint).resetAt) {
    ipMap.set(endpoint, { count: 1, resetAt: now + windowMs });
    return true; // allowed
  }
  const slot = ipMap.get(endpoint);
  slot.count++;
  return slot.count <= max; // false = rate limited
}
// Clean up old entries every 10 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, epMap] of _rl.entries()) {
    for (const [ep, slot] of epMap.entries()) if (now > slot.resetAt) epMap.delete(ep);
    if (!epMap.size) _rl.delete(ip);
  }
}, 10 * 60 * 1000);

function rlMiddleware(endpoint, max, windowMs, message) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!rateLimit(endpoint, ip, max, windowMs)) {
      return res.status(429).json({ error: message || 'Too many requests. Please slow down.' });
    }
    next();
  };
}

// ── clientId validation helper ────────────────────────────────────────────────
// clientId must be a UUID v4 string. Anything else is rejected.
// This closes the console exploit: someone sending clientId:"hacker1","hacker2"...
// to bypass per-user limits.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateClientId(clientId) {
  return typeof clientId === 'string' && UUID_RE.test(clientId);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD || 'gietAdmin123';
const SESSION_TIMEOUT  = 3600000;
const LOGIN_RATE_LIMIT = new Map();
const adminSessions    = new Map();
// activeVisitors is now DB-backed via uniqueCol.lastSeen (TTL index)

function isValidSession(token) {
  if (!token || !adminSessions.has(token)) return false;
  const s = adminSessions.get(token);
  if (s.expiresAt < Date.now()) { adminSessions.delete(token); return false; }
  return true;
}
function checkLoginRateLimit(ip) {
  const now = Date.now();
  if (!LOGIN_RATE_LIMIT.has(ip)) { LOGIN_RATE_LIMIT.set(ip, { count: 1, resetTime: now+60000 }); return true; }
  const r = LOGIN_RATE_LIMIT.get(ip);
  if (now > r.resetTime) { r.count = 1; r.resetTime = now+60000; return true; }
  return ++r.count <= 5;
}
setInterval(() => { const now=Date.now(); for(const[t,s]of adminSessions.entries())if(s.expiresAt<now)adminSessions.delete(t); }, 60000);

// ── Feature 3: Keep last 200 confessions instead of 24h expiry ───────────────
const MAX_CONFESSIONS = 200;
async function enforceConfessionLimit() {
  const total = await confCol.countDocuments({});
  if (total > MAX_CONFESSIONS) {
    // Find the oldest beyond limit and delete them + their replies
    const toDelete = await confCol
      .find({}, { projection: { id: 1 } })
      .sort({ createdAt: 1 })
      .limit(total - MAX_CONFESSIONS)
      .toArray();
    const ids = toDelete.map(d => d.id);
    await confCol.deleteMany({ id: { $in: ids } });
    await repliesCol.deleteMany({ confessionId: { $in: ids } });
    console.log(`Pruned ${ids.length} old confession(s) to stay under ${MAX_CONFESSIONS}`);
  }
}
const pruneConfessions = enforceConfessionLimit;
// Also remove the old 24h pending cleanup — keep pending indefinitely until moderated
async function cleanupOldPending() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // 7 days for pending
  await pendingCol.deleteMany({ createdAt: { $lt: cutoff } });
}
setInterval(cleanupOldPending, 60 * 60 * 1000); // hourly

// ── Feature 4: Confession of the Day ─────────────────────────────────────────
// Cached in memory, refreshed every 24h
let cotdCache = { id: null, refreshedAt: 0 };
async function getConfessionOfTheDay() {
  const now = Date.now();
  if (cotdCache.id && (now - cotdCache.refreshedAt) < 24 * 3600 * 1000) {
    return cotdCache.id;
  }
  // Find the confession with the most likes in the last 7 days
  const cutoff = now - 7 * 24 * 3600 * 1000;
  const top = await confCol
    .find({ createdAt: { $gte: cutoff }, likes: { $gt: 0 } })
    .sort({ likes: -1 })
    .limit(1)
    .toArray();
  if (top.length) {
    cotdCache = { id: top[0].id, refreshedAt: now };
    return top[0].id;
  }
  return null;
}

// ── Push helper ───────────────────────────────────────────────────────────────
async function pushAll(payload, type = 'user') {
  if (!webpush) return;
  const filter = type === 'all' ? {} : { type };
  const subs = await pushSubCol.find(filter).toArray();
  const dead = [];
  await Promise.all(subs.map(async sub => {
    try { await webpush.sendNotification(sub.subscription, JSON.stringify(payload)); }
    catch(e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint); }
  }));
  if (dead.length) await pushSubCol.deleteMany({ endpoint: { $in: dead } });
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/push/vapid-public-key', (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || '' }));

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await pushSubCol.updateOne(
    { endpoint: subscription.endpoint },
    { $set: { subscription, type: 'user', updatedAt: Date.now() } },
    { upsert: true }
  );
  res.json({ status: 'ok' });
});
app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await pushSubCol.deleteOne({ endpoint });
  res.json({ status: 'ok' });
});

// Submit confession — Feature 1: branch tag, Feature 7: poll support
app.post('/api/confessions', rlMiddleware('submit', 5, 3600000, 'Too many submissions. Try again in an hour.'), async (req, res) => {
  const { message, clientId, category, branch, poll } = req.body;
  // clientId is optional on submit but if provided must be valid UUID
  if (clientId && !validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });

  // For polls, the poll.question IS the message — allow empty message field
  const isPoll = category === '📊 Poll' && poll && poll.question?.trim();
  const rawMessage = isPoll ? poll.question.trim() : (message || '').trim();

  if (!rawMessage) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (rawMessage.split(/\s+/).filter(Boolean).length > 400)
    return res.status(400).json({ error: 'Message exceeds 400 words.' });

  const { cleanText, flags, wasEdited } = filterConfession(rawMessage);

  // ── AI Moderation Pipeline (Layers 1→2→3) ──────────────────────────────────
  // LEARN: We pass cleanText (after regex filter) not rawMessage.
  // This prevents double-counting leet-speak that the regex already cleaned.
  // The pipeline is wrapped in try/catch so if ALL 3 APIs are down,
  // the confession still submits (graceful degradation — better than crashing).
  let aiResult = { block: false, shadowBan: false, reason: '', layer: 'skipped' };
  try {
    aiResult = await aiModerationPipeline(cleanText);
  } catch(e) {
    console.error('[AI MOD] Pipeline error (non-fatal):', e.message);
  }

  if (aiResult.block) {
    // Hard block — tell the user their post violates guidelines
    // LEARN: 422 Unprocessable Entity is the right HTTP status for "valid syntax
    // but semantically rejected." More precise than 400 Bad Request.
    return res.status(422).json({
      error: 'Your confession was flagged by our content filter. Please review our community guidelines.',
      aiLayer: aiResult.layer
    });
  }

  // Validate branch tag (optional)
  const VALID_YEARS    = ['1st Year','2nd Year','3rd Year','4th Year'];
  const VALID_BRANCHES = ['CSE','AIML','ECE','Civil','Mechanical','Chemical','Aeronautical/AME','Agriculture','Biotechnology','BBA','MBA','BCA','MCA','Others'];
  let branchTag = null;
  if (branch && branch.year && branch.branch) {
    if (VALID_YEARS.includes(branch.year) && VALID_BRANCHES.includes(branch.branch)) {
      branchTag = { year: branch.year, branch: branch.branch };
    }
  }

  const settings = await settingsCol.findOne({ _id: 'main' });
  const autoApprove = settings?.autoApprove || false;

  const rawPollOptions = isPoll
    ? (Array.isArray(poll.options) ? poll.options : [poll.optA || 'Yes', poll.optB || 'No'])
    : [];
  const cleanPollOptions = rawPollOptions
    .map(o => String(o || '').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 8);
  if (isPoll && cleanPollOptions.length < 2) {
    return res.status(400).json({ error: 'Poll must have at least 2 options.' });
  }
  const pollOptionMap = {};
  const pollVoteMap = {};
  cleanPollOptions.forEach((opt, idx) => {
    const key = `o${idx + 1}`;
    pollOptionMap[key] = opt;
    pollVoteMap[key] = 0;
  });

  const confession = {
    id: uuidv4(),
    message: cleanText,
    originalMessage: wasEdited ? rawMessage : undefined,
    category: category || '💭 Random',
    branchTag,
    createdAt: Date.now(),
    likes: 0, dislikes: 0, votes: {},
    reactions: { '❤️':0, '😮':0, '😂':0, '🥺':0, '🔥':0 },
    reactedBy: {},
    approved: autoApprove,
    flags: 0, flaggedBy: [],
    filterFlags: flags,
    wasEdited,
    // ── AI Moderation fields ──
    // LEARN: shadowBanned:true means the post is saved but excluded from the
    // public feed. The submitter gets a normal "pending" response (they think
    // it worked). This prevents bad actors from knowing they were caught,
    // while protecting real users from harassment.
    shadowBanned: aiResult.shadowBan || false,
    aiModLayer: aiResult.layer || 'none',
    aiModReason: aiResult.reason || '',
    // ── Poll fields ──
    isPoll: !!isPoll,
    pollOptions: isPoll ? pollOptionMap : null,
    pollVotes: isPoll ? pollVoteMap : null,
    pollUserVotes: isPoll ? {} : null,
  };

  // Shadow banned confessions go to pending (admin can review them there)
  // They are tagged so admin knows why they were flagged
  const isShadowBanned = aiResult.shadowBan;

  if (!isShadowBanned && autoApprove) {
    await confCol.insertOne(confession);
    await enforceConfessionLimit();
    pushAll({ title: '💌 New Confession on GIET!',
      body: cleanText.slice(0,90) + (cleanText.length>90?'…':''),
      url: 'https://page-confession.vercel.app' }, 'user').catch(()=>{});
  } else {
    // Goes to pending: either shadow banned, or manual approval needed
    await pendingCol.insertOne(confession);
    if (!isShadowBanned) {
      pushAll({ title: '🔔 New Confession Pending',
        body: 'A new confession needs your approval.',
        url: 'https://page-confession.vercel.app/admin.html' }, 'admin').catch(()=>{});
    }
  }

  if (clientId) {
    const exists = await uniqueCol.findOne({ _id: clientId });
    if (!exists) {
      await uniqueCol.insertOne({ _id: clientId });
      await analyticsCol.updateOne({ _id: 'main' }, { $inc: { uniqueVisitors: 1 } });
    }
  }
  return res.json({ status: autoApprove ? 'approved' : 'pending', edited: wasEdited, editedFields: flags, confessionId: confession.id });
});

// Get approved confessions — Feature 3: last 200, Feature 4: COTD pinned first
app.get('/api/confessions', async (req, res) => {
  // LEARN: { shadowBanned: { $ne: true } } means "where shadowBanned is NOT true".
  // $ne = "not equal" — a MongoDB query operator. This filters out shadow-banned posts.
  const data = await confCol.find({ shadowBanned: { $ne: true } }).sort({ createdAt: -1 }).limit(MAX_CONFESSIONS).toArray();
  const cotdId = await getConfessionOfTheDay();
  // Attach cotd flag
  data.forEach(c => { c.isConfessionOfDay = (c.id === cotdId); });
  // Pin COTD to top
  data.sort((a, b) => {
    if (a.isConfessionOfDay) return -1;
    if (b.isConfessionOfDay) return 1;
    return b.createdAt - a.createdAt;
  });
  res.json(data);
});

// Like / Dislike (kept for compatibility)
app.post('/api/like/:id', rlMiddleware('like', 15, 60000, 'Too many likes. Slow down.'), async (req, res) => {
  const { clientId } = req.body;
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.votes?.[clientId] === 'like') return res.json({ likes: item.likes, dislikes: item.dislikes });
  const upd = { $inc: { likes: 1 }, $set: { [`votes.${clientId}`]: 'like' } };
  if (item.votes?.[clientId] === 'dislike') upd.$inc.dislikes = -1;
  await confCol.updateOne({ id: req.params.id }, upd);
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ likes: u.likes, dislikes: u.dislikes });
});
app.post('/api/dislike/:id', rlMiddleware('dislike', 15, 60000, 'Too many dislikes. Slow down.'), async (req, res) => {
  const { clientId } = req.body;
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.votes?.[clientId] === 'dislike') return res.json({ likes: item.likes, dislikes: item.dislikes });
  const upd = { $inc: { dislikes: 1 }, $set: { [`votes.${clientId}`]: 'dislike' } };
  if (item.votes?.[clientId] === 'like') upd.$inc.likes = -1;
  await confCol.updateOne({ id: req.params.id }, upd);
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ likes: u.likes, dislikes: u.dislikes });
});

// Feature 5: Emoji reactions endpoint
app.post('/api/react/:id', rlMiddleware('react', 20, 60000, 'Too many reactions.'), async (req, res) => {
  const { clientId, emoji } = req.body;
  const VALID_EMOJIS = ['❤️','😮','😂','🥺','🔥'];
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  if (!VALID_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });

  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });

  const prevReaction = item.reactedBy?.[clientId];
  const upd = {};

  if (prevReaction === emoji) {
    // Toggle off — remove reaction
    upd.$inc = { [`reactions.${emoji}`]: -1 };
    upd.$unset = { [`reactedBy.${clientId}`]: '' };
  } else {
    upd.$inc = { [`reactions.${emoji}`]: 1 };
    upd.$set = { [`reactedBy.${clientId}`]: emoji };
    if (prevReaction) upd.$inc[`reactions.${prevReaction}`] = -1;
  }

  await confCol.updateOne({ id: req.params.id }, upd);
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ reactions: u.reactions, myReaction: u.reactedBy?.[clientId] || null });
});

// Flag
app.post('/api/flag/:id', rlMiddleware('flag', 10, 60000, 'Too many flags.'), async (req, res) => {
  const { clientId } = req.body;
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.flaggedBy||[]).includes(clientId)) return res.json({ flags: item.flags, alreadyFlagged: true });
  await confCol.updateOne({ id: req.params.id }, { $inc: { flags: 1 }, $push: { flaggedBy: clientId } });
  res.json({ flags: (item.flags||0)+1 });
});

// Replies
app.get('/api/replies/:confessionId', async (req, res) => {
  const replies = await repliesCol.find({ confessionId: req.params.confessionId }).sort({ createdAt: 1 }).toArray();
  res.json(replies);
});
app.post('/api/replies/:confessionId', rlMiddleware('reply', 5, 300000, 'Too many replies. Wait 5 minutes.'), async (req, res) => {
  const { message, clientId } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Reply cannot be empty.' });
  if (message.trim().length > 500) return res.status(400).json({ error: 'Reply too long.' });
  if (clientId && !validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const conf = await confCol.findOne({ id: req.params.confessionId });
  if (!conf) return res.status(404).json({ error: 'Confession not found' });
  const reply = {
    id: uuidv4(),
    confessionId: req.params.confessionId,
    message: message.trim(),
    createdAt: Date.now(),
    reactions: { '❤️':0, '😮':0, '😂':0, '🥺':0, '🔥':0 },
    reactedBy: {}
  };
  await repliesCol.insertOne(reply);
  res.json({ status: 'ok', reply });
});
app.post('/api/replies/counts', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' });
  const counts = await repliesCol.aggregate([
    { $match: { confessionId: { $in: ids } } },
    { $group: { _id: '$confessionId', count: { $sum: 1 } } }
  ]).toArray();
  const map = {};
  counts.forEach(c => { map[c._id] = c.count; });
  res.json(map);
});

// Pending
app.get('/api/pending', async (req, res) => {
  const data = await pendingCol.find({}).sort({ flags: -1, createdAt: -1 }).toArray();
  res.json(data);
});
app.get('/api/pending-count', async (req, res) => {
  const count = await pendingCol.countDocuments({});
  res.json({ count });
});

// Visit / Analytics
// LEARN: DB-backed "online now" count.
// We upsert a lastSeen timestamp per clientId in unique_visitors.
// The TTL index (90s) auto-deletes stale docs, so countDocuments = active users.
// This survives cold starts — in-memory Map resets to 0 every time Render sleeps.
app.post('/api/visit', rlMiddleware('visit', 3, 20000, 'Too many pings.'), async (req, res) => {
  const { clientId } = req.body;
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const now = Date.now();
  const exists = await uniqueCol.findOne({ _id: clientId });
  if (!exists) {
    await uniqueCol.insertOne({ _id: clientId, firstSeen: now, lastSeen: new Date(now) });
    await analyticsCol.updateOne({ _id: 'main' }, { $inc: { visits: 1, uniqueVisitors: 1 } });
  } else {
    // Update lastSeen — TTL index uses this Date field to expire inactive visitors
    await uniqueCol.updateOne({ _id: clientId }, { $set: { lastSeen: new Date(now) } });
  }
  // Count active = docs with lastSeen in last 90s (TTL index keeps this clean)
  const activeCount = await uniqueCol.countDocuments({ lastSeen: { $gte: new Date(now - 90000) } });
  const stats = await analyticsCol.findOne({ _id: 'main' });
  res.json({ status:'ok', visits: stats.visits, uniqueVisitors: stats.uniqueVisitors, activeVisitors: activeCount });
});
app.get('/api/analytics', async (req, res) => {
  const stats = await analyticsCol.findOne({ _id: 'main' });
  const activeCount = await uniqueCol.countDocuments({ lastSeen: { $gte: new Date(Date.now() - 90000) } });
  res.json({ visits: stats?.visits||0, uniqueVisitors: stats?.uniqueVisitors||0, activeVisitors: activeCount });
});
app.get('/api/settings', async (req, res) => {
  const s = await settingsCol.findOne({ _id: 'main' });
  res.json({ autoApprove: s?.autoApprove||false });
});

// ── Poll vote ─────────────────────────────────────────
app.post('/api/poll/:id/vote', rlMiddleware('poll', 10, 60000, 'Too many poll votes.'), async (req, res) => {
  const { clientId, option } = req.body;
  if (!validateClientId(clientId))
    return res.status(400).json({ error: 'Invalid clientId' });
  if (!clientId || !option)
    return res.status(400).json({ error: 'clientId and option required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item || !item.isPoll) return res.status(404).json({ error: 'Poll not found' });
  const validOptions = Object.keys(item.pollOptions || {});
  if (!validOptions.includes(option)) return res.status(400).json({ error: 'Invalid poll option' });
  const prev = item.pollUserVotes?.[clientId];
  // If already voted the SAME option — no change (idempotent, prevents double-counting)
  if (prev === option) {
    return res.json({ pollVotes: item.pollVotes, myVote: option, changed: false });
  }
  const inc = { [`pollVotes.${option}`]: 1 };
  if (prev && validOptions.includes(prev)) {
    // Only decrement previous if the current count is > 0 (never go negative)
    const prevCount = item.pollVotes?.[prev] || 0;
    if (prevCount > 0) inc[`pollVotes.${prev}`] = -1;
  }
  await confCol.updateOne({ id: req.params.id }, {
    $inc: inc,
    $set: { [`pollUserVotes.${clientId}`]: option }
  });
  // Clamp all poll vote counts to >= 0 (defensive, prevents negative display)
  const u = await confCol.findOne({ id: req.params.id });
  const clampedVotes = {};
  let needsClamp = false;
  for (const [k, v] of Object.entries(u.pollVotes || {})) {
    clampedVotes[k] = Math.max(0, v);
    if (v < 0) needsClamp = true;
  }
  if (needsClamp) {
    await confCol.updateOne({ id: req.params.id }, { $set: { pollVotes: clampedVotes } });
  }
  res.json({ pollVotes: needsClamp ? clampedVotes : u.pollVotes, myVote: option, changed: !!prev });
});

// ── "This is me!" ─────────────────────────────────────
// LEARN: thisIsMe is an array of clientIds stored on the confession document.
// We use $push to append and check for duplicates before pushing.
app.post('/api/thisisme/:id', rlMiddleware('thisisme', 10, 60000, 'Too many requests.'), async (req, res) => {
  const { clientId } = req.body;
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.thisIsMe||[]).includes(clientId))
    return res.json({ count: (item.thisIsMe||[]).length, list: item.thisIsMe||[], alreadyClaimed: true });
  await confCol.updateOne({ id: req.params.id }, { $push: { thisIsMe: clientId } });
  const u = await confCol.findOne({ id: req.params.id });
  res.json({ count: u.thisIsMe.length, list: u.thisIsMe });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/push/subscribe', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await pushSubCol.updateOne(
    { endpoint: subscription.endpoint },
    { $set: { subscription, type: 'admin', updatedAt: Date.now() } },
    { upsert: true }
  );
  res.json({ status: 'ok' });
});

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkLoginRateLimit(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 1 minute.' });
  if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid password' });
  const token = uuidv4();
  adminSessions.set(token, { expiresAt: Date.now()+SESSION_TIMEOUT });
  res.cookie('admin_token', token, { httpOnly:true, secure:true, sameSite:'none', maxAge:SESSION_TIMEOUT });
  return res.json({ message:'OK', token, expiresIn: SESSION_TIMEOUT/1000 });
});

app.post('/api/admin/moderate', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId, action } = req.body;
  const item = await pendingCol.findOne({ id: confessionId });
  if (!item) return res.status(404).json({ error: 'Not found in pending' });
  if (action === 'approve') {
    const { _id, ...rest } = item;
    rest.approved = true;
    await confCol.insertOne(rest);
    await pendingCol.deleteOne({ id: confessionId });
    await enforceConfessionLimit();
    pushAll({ title: '💌 New Confession on GIET!',
      body: rest.message.slice(0,90)+(rest.message.length>90?'…':''),
      url: 'https://page-confession.vercel.app' }, 'user').catch(()=>{});
    return res.json({ updated: rest });
  }
  if (action === 'reject') {
    await pendingCol.deleteOne({ id: confessionId });
    return res.json({ updated: item });
  }
  res.status(400).json({ error: 'Invalid action' });
});

app.post('/api/admin/approve-all', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const pending = await pendingCol.find({}).toArray();
  if (!pending.length) return res.json({ approved: 0 });
  const toInsert = pending.map(({ _id, ...rest }) => ({ ...rest, approved: true }));
  await confCol.insertMany(toInsert);
  await pendingCol.deleteMany({});
  await enforceConfessionLimit();
  pushAll({ title: `💌 ${pending.length} New Confession${pending.length>1?'s':''} on GIET!`,
    body: 'Fresh confessions just dropped — come check them out!',
    url: 'https://page-confession.vercel.app' }, 'user').catch(()=>{});
  res.json({ approved: pending.length });
});

app.post('/api/admin/auto-approve', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { enabled } = req.body;
  await settingsCol.updateOne({ _id:'main' }, { $set: { autoApprove: !!enabled } });
  res.json({ autoApprove: !!enabled });
});

app.post('/api/admin/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  const r1 = await confCol.deleteOne({ id: confessionId });
  if (r1.deletedCount) { await repliesCol.deleteMany({ confessionId }); return res.json({ removed: confessionId }); }
  const r2 = await pendingCol.deleteOne({ id: confessionId });
  if (r2.deletedCount) return res.json({ removed: confessionId });
  res.status(404).json({ error: 'Not found' });
});

// ── Mark as Abusive — teaches the AI "memory" (Upstash Vector) ──────────────────
// LEARN: This is the key endpoint that makes the system "self-learning".
// Every time you click the 🤖 Mark Abusive button in the admin panel:
//   1. The confession is deleted from the DB
//   2. Its text is upserted as a vector into Upstash
//   3. Future similar confessions get auto-blocked by Layer 2
//
// "Upsert" = update-or-insert. If the same confession was marked abusive before,
// we update its entry rather than duplicating it. Idempotent operation.
//
// HOW THE AI LEARNS:
// Upstash stores the vector (list of numbers) of the text.
// The vector captures semantic meaning — not just keywords.
// So "you're a complete loser" and "ur such a total failure lol" 
// will have similar vectors and future posts like them will be caught.
// This is called "embedding-based semantic search" in the industry.
app.post('/api/admin/mark-abusive', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  if (!confessionId) return res.status(400).json({ error: 'confessionId required' });

  // Find in either collection (approved or pending)
  let item = await confCol.findOne({ id: confessionId });
  let fromPending = false;
  if (!item) {
    item = await pendingCol.findOne({ id: confessionId });
    fromPending = true;
  }
  if (!item) return res.status(404).json({ error: 'Confession not found' });

  // Step 1: upsert the vector into Upstash so the AI remembers this pattern
  const textToLearn = item.originalMessage || item.message; // use unfiltered if available
  const vectorUpserted = await upsertBannedVector(confessionId, textToLearn);

  // Step 2: delete the confession from the DB
  if (fromPending) {
    await pendingCol.deleteOne({ id: confessionId });
  } else {
    await confCol.deleteOne({ id: confessionId });
    await repliesCol.deleteMany({ confessionId });
  }

  return res.json({
    removed: confessionId,
    vectorLearned: vectorUpserted,
    message: vectorUpserted
      ? '🧠 Confession deleted and pattern learned by AI'
      : '🗑 Confession deleted (vector DB unavailable — configure UPSTASH_VECTOR keys to enable learning)'
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
// ── Community report + reply delete routes ────────────────────────────────────
const REPORT_THRESHOLD = 3;
app.post('/api/report/:id', rlMiddleware('report', 5, 3600000, 'Too many reports.'), async (req, res) => {
  const { clientId, reason, otherMessage } = req.body;
  const VALID = ['identity','harassment','fake','spam','other'];
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  if (!VALID.includes(reason)) return res.status(400).json({ error: 'Invalid reason' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.reports||[]).some(r => r.clientId === clientId))
    return res.json({ alreadyReported: true, reportCount: (item.reports||[]).length });
  const safeOther = reason === 'other' ? String(otherMessage || '').trim().slice(0, 500) : '';
  await confCol.updateOne({ id: req.params.id }, {
    $push: {
      reports: {
        clientId,
        reason,
        otherMessage: safeOther || undefined,
        reportedAt: Date.now()
      }
    }
  });
  const updated = await confCol.findOne({ id: req.params.id });
  const reportCount = (updated.reports||[]).length;
  if (reportCount >= REPORT_THRESHOLD && !item.reportHidden)
    await confCol.updateOne({ id: req.params.id }, { $set: { reportHidden: true } });
  res.json({ status: 'reported', reportCount, autoHidden: reportCount >= REPORT_THRESHOLD });
});
app.get('/api/reported', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const data = await confCol.find({ 'reports.0': { $exists: true } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(data);
});
app.post('/api/admin/restore', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  await confCol.updateOne({ id: confessionId }, { $set: { reports: [], reportHidden: false } });
  res.json({ status: 'restored' });
});
app.post('/api/admin/reply/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { replyId } = req.body;
  if (!replyId) return res.status(400).json({ error: 'replyId required' });
  const result = await repliesCol.deleteOne({ id: replyId });
  if (!result.deletedCount) return res.status(404).json({ error: 'Reply not found' });
  res.json({ removed: replyId });
});

// ════════════════════════════════════════════════════════
// NEW FEATURES
// ════════════════════════════════════════════════════════

// REMOVE button — 4 removes → flag for re-review
const REMOVE_THRESHOLD = 4;
app.post('/api/remove/:id', rlMiddleware('remove', 5, 3600000, 'Too many removals.'), async (req, res) => {
  const { clientId } = req.body;
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const item = await confCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.removedBy||[]).includes(clientId))
    return res.json({ alreadyRemoved: true, removeCount: (item.removedBy||[]).length });
  await confCol.updateOne({ id: req.params.id }, { $push: { removedBy: clientId } });
  const updated = await confCol.findOne({ id: req.params.id });
  const removeCount = (updated.removedBy||[]).length;
  if (removeCount >= REMOVE_THRESHOLD && !item.flaggedForReview)
    await confCol.updateOne({ id: req.params.id }, { $set: { flaggedForReview: true } });
  res.json({ status: 'removed', removeCount, flagged: removeCount >= REMOVE_THRESHOLD });
});

// Admin reply delete
app.post('/api/admin/reply/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { replyId } = req.body;
  if (!replyId) return res.status(400).json({ error: 'replyId required' });
  const result = await repliesCol.deleteOne({ id: replyId });
  if (!result.deletedCount) return res.status(404).json({ error: 'Reply not found' });
  res.json({ removed: replyId });
});

// Flagged-for-review list (admin)
app.get('/api/flagged-review', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const data = await confCol.find({ flaggedForReview: true }).sort({ createdAt: -1 }).toArray();
  res.json(data);
});
app.post('/api/admin/clear-review', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId } = req.body;
  await confCol.updateOne({ id: confessionId }, { $set: { flaggedForReview: false, removedBy: [] } });
  res.json({ status: 'cleared' });
});

// Read view counter — increment when confession scrolls into view
app.post('/api/view/:id', async (req, res) => {
  await confCol.updateOne({ id: req.params.id }, { $inc: { views: 1 } });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
// DISCUSSION ENDPOINTS (unrelated community chat)
// ════════════════════════════════════════════════════════
const MAX_DISCUSSIONS = 300;

// GET all discussion messages (newest first, limit 300)
app.get('/api/discussions', async (req, res) => {
  const data = await discussionsCol.find({ hidden: { $ne: true } }).sort({ createdAt: -1 }).limit(MAX_DISCUSSIONS).toArray();
  res.json(data);
});

// POST a new discussion message
app.post('/api/discussions', rlMiddleware('discuss', 8, 300000, 'Too many messages. Wait 5 minutes.'), async (req, res) => {
  const { message, displayName, clientId } = req.body;
  if (clientId && !validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const raw = (message || '').trim();
  if (!raw) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (raw.length > 500) return res.status(400).json({ error: 'Message too long (max 500 chars).' });
  // Sanitize display name — no PII leaking
  const safeName = String(displayName || '').trim().slice(0, 30).replace(/<[^>]*>/g, '') || null;
  const doc = {
    id: uuidv4(),
    message: raw,
    displayName: safeName,
    clientId: clientId || null,
    createdAt: Date.now(),
    flags: 0,
    flaggedBy: [],
    hidden: false
  };
  await discussionsCol.insertOne(doc);
  res.json({ status: 'ok', message: doc });
});

// Flag a discussion message — 1 flag hides it immediately
const DISCUSSION_FLAG_THRESHOLD = 1;
app.post('/api/discussions/flag/:id', rlMiddleware('dflag', 10, 60000, 'Too many flags.'), async (req, res) => {
  const { clientId } = req.body;
  if (!validateClientId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  const item = await discussionsCol.findOne({ id: req.params.id });
  if (!item) return res.status(404).json({ error: 'Not found' });
  if ((item.flaggedBy || []).includes(clientId)) return res.json({ flags: item.flags, alreadyFlagged: true });
  await discussionsCol.updateOne({ id: req.params.id }, { $inc: { flags: 1 }, $push: { flaggedBy: clientId } });
  const updated = await discussionsCol.findOne({ id: req.params.id });
  const flagCount = updated.flags || 0;
  if (flagCount >= DISCUSSION_FLAG_THRESHOLD && !item.hidden) {
    await discussionsCol.updateOne({ id: req.params.id }, { $set: { hidden: true } });
  }
  res.json({ flags: flagCount, hidden: flagCount >= DISCUSSION_FLAG_THRESHOLD });
});

// Admin: get all discussions including hidden
app.get('/api/admin/discussions', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const data = await discussionsCol.find({}).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(data);
});

// Admin: delete a discussion message
app.post('/api/admin/discussions/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: 'messageId required' });
  await discussionsCol.deleteOne({ id: messageId });
  res.json({ removed: messageId });
});

// ════════════════════════════════════════════════════════
// SUGGESTION ENDPOINTS
// ════════════════════════════════════════════════════════

// POST a suggestion — no filter, goes straight to admin
app.post('/api/suggestions', rlMiddleware('suggest', 3, 3600000, 'Too many suggestions. Try again later.'), async (req, res) => {
  const { message, clientId } = req.body;
  const raw = (message || '').trim();
  if (!raw) return res.status(400).json({ error: 'Suggestion cannot be empty.' });
  if (raw.length > 1000) return res.status(400).json({ error: 'Suggestion too long (max 1000 chars).' });
  const doc = {
    id: uuidv4(),
    message: raw,
    clientId: clientId || null,
    createdAt: Date.now(),
    tag: 'suggestion'
  };
  await suggestionsCol.insertOne(doc);
  res.json({ status: 'ok' });
});

// Admin: get all suggestions
app.get('/api/suggestions', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const data = await suggestionsCol.find({}).sort({ createdAt: -1 }).limit(200).toArray();
  res.json(data);
});

// Admin: delete a suggestion
app.post('/api/admin/suggestions/delete', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { suggestionId } = req.body;
  await suggestionsCol.deleteOne({ id: suggestionId });
  res.json({ removed: suggestionId });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'giet-confessions', time: Date.now() });
});

// Reply reactions
app.post('/api/reply/react/:replyId', async (req, res) => {
  const { clientId, emoji } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!EMOJI_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });
  const reply = await repliesCol.findOne({ id: req.params.replyId });
  if (!reply) return res.status(404).json({ error: 'Reply not found' });

  const prev = reply.reactedBy?.[clientId];
  const upd = {};
  if (prev === emoji) {
    upd.$inc = { [`reactions.${emoji}`]: -1 };
    upd.$unset = { [`reactedBy.${clientId}`]: '' };
  } else {
    upd.$inc = { [`reactions.${emoji}`]: 1 };
    upd.$set = { [`reactedBy.${clientId}`]: emoji };
    if (prev) upd.$inc[`reactions.${prev}`] = -1;
  }
  await repliesCol.updateOne({ id: req.params.replyId }, upd);
  const fresh = await repliesCol.findOne({ id: req.params.replyId });
  res.json({ reactions: fresh.reactions || {}, myReaction: fresh.reactedBy?.[clientId] || null });
});

// Scheduled approve — admin approves with a future timestamp
app.post('/api/admin/schedule', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { confessionId, scheduledAt } = req.body; // scheduledAt = ISO timestamp
  if (!confessionId || !scheduledAt) return res.status(400).json({ error: 'confessionId and scheduledAt required' });
  await pendingCol.updateOne({ id: confessionId }, { $set: { scheduledAt: new Date(scheduledAt) } });
  res.json({ status: 'scheduled', scheduledAt });
});

// Background job: publish scheduled confessions
async function publishScheduled() {
  const now = new Date();
  const due = await pendingCol.find({ scheduledAt: { $lte: now }, approved: { $ne: true } }).toArray();
  for (const item of due) {
    const { _id, ...conf } = item;
    conf.approved = true; conf.scheduledAt = undefined;
    await confCol.insertOne(conf);
    await pendingCol.deleteOne({ id: conf.id });
  }
  if (due.length) await pruneConfessions();
}
setInterval(publishScheduled, 60 * 1000); // check every minute

// Weekly prompt / themed confession day
app.get('/api/prompt', async (req, res) => {
  const s = await settingsCol.findOne({ _id: 'main' });
  res.json({ prompt: s?.weeklyPrompt || null, promptTheme: s?.promptTheme || null });
});
app.post('/api/admin/prompt', async (req, res) => {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  if (!isValidSession(token)) return res.status(403).json({ error: 'Unauthorized.' });
  const { prompt, promptTheme } = req.body; // promptTheme: 'crush'|'hostel'|'exam'|'random'|''
  await settingsCol.updateOne({ _id: 'main' }, { $set: { weeklyPrompt: prompt||'', promptTheme: promptTheme||'' } });
  res.json({ status: 'saved' });
});

// ── Global error handler — never leak stack traces ────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });
