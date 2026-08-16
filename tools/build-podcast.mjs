#!/usr/bin/env node
// Bygger en norsk lyttepodkast av ordene i index.html.
//
//   0. historier  Claude skriver en liten historie per ord   -> stories.json   (i git)
//   1. klipp      Azure leser den inn                        -> .cache/clips/  (ikke i git)
//   2. episoder   ffmpeg syr klippene sammen                 -> episodes/      (ikke i git)
//
// Kjør `node tools/build-podcast.mjs --help` for flagg.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const STORIES = path.join(ROOT, 'stories.json');
const CACHE = path.join(ROOT, '.cache');
const CLIPS = path.join(CACHE, 'clips');
const SILENCE = path.join(CACHE, 'silence');
const EPISODES = path.join(ROOT, 'episodes');
const WORDS_DIR = path.join(ROOT, 'ord');

// ─────────────────────────────────────────────────────────────── innstillinger

// Claude kjører på Amazon Bedrock, samme oppsett som animalhotels-browser:
// standard AWS-legitimasjonskjede og en EU-inferensprofil. Leses som funksjoner
// fordi .env lastes etter at modulen er evaluert.
const awsRegion = () => process.env.AWS_REGION || 'eu-central-1';
const modelId = () => process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-opus-4-6-v1';
const effort = () => process.env.BEDROCK_EFFORT || 'low';

const PROMPT_VERSION = 1; // bump denne for å regenerere alle ulåste historier

const NB_VOICE = 'nb-NO-PernilleNeural';
const EN_VOICE = 'en-GB-SoniaNeural';
const SPEECH_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const EPISODE_MAX_SECONDS = 15 * 60;
const DECK_ORDER = [
  'Tur-retur',
  'Peppa Pig',
  'Distriktsnyheter Rogaland',
  'finn.no',
  'Andre',
  'Uregelrette verb',
];
const DECK_TITLES = { 'Distriktsnyheter Rogaland': 'Distriktsnyheter' };

// ────────────────────────────────────────────────────────────────────── flagg

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const opts = {
  dry: flag('dry'),
  print: flag('print'),
  listVoices: flag('list-voices'),
  storiesOnly: flag('stories-only'),
  audioOnly: flag('audio-only'),
  episodesOnly: flag('episodes-only'),
  withExample: flag('with-example'),
  prune: flag('prune'),
  perWord: flag('per-word'),
  syncApp: flag('sync-app'),
  force: flag('force'),
  fakeAudio: flag('fake-audio'),
  only: value('only', null),
  deck: value('deck', null),
  limit: Number(value('limit', 0)) || 0,
  pause: Number(value('pause', 1500)),
  gap: Number(value('gap', 1000)),
  rate: value('rate', '-8%'),
  // Historiene er sammenhengende prosa og tåler mindre tempo enn de løsrevne
  // formene. Faller tilbake til --rate hvis den ikke settes.
  storyRate: value('story-rate', null),
  concurrency: Number(value('concurrency', 4)),
};

if (flag('help')) {
  console.log(`
  node tools/build-podcast.mjs [flagg]

    --dry             skriv ut historie-prompter, ingen API-kall
    --print           skriv ut historiene som allerede finnes, for gjennomlesing
    --only=<søk>      bare ord som matcher (norsk eller engelsk)
    --deck=<søk>      bare ord fra kortstokker som matcher, f.eks. distrikts
    --limit=N         stopp etter N ord
    --stories-only    bare steg 0
    --audio-only      bare steg 1
    --episodes-only   bare steg 2
    --per-word        én mp3 per ord i ord/ i stedet for sammensydde episoder
    --sync-app        skriv historiene inn i index.html så de vises på kortene
    --with-example    les også bokeksempelet, ikke bare historien
    --pause=<ms>      tenkepause før den engelske oversettelsen (standard 1500)
    --gap=<ms>        stillhet mellom ord i en episode (standard 1000)
    --rate=<pct>      taletempo, f.eks. -8% (standard) eller +0%
    --story-rate=<pct> eget tempo for historiene (standard: samme som --rate)
    --concurrency=N   parallelle forespørsler (standard 4)
    --fake-audio      lag pipetoner i stedet for å ringe Azure, for å teste
                      sammensyingen uten å bruke kvote
    --list-voices     list opp Azure-stemmene i regionen din
    --prune           slett klipp som ingen ord peker på lenger
    --force           regenerer historier selv om hashen stemmer
`);
  process.exit(0);
}

// ──────────────────────────────────────────────────────────────────── hjelpere

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

function slug(s) {
  return s
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

async function loadEnv() {
  const raw = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    // Tomme verdier settes ikke: en tom ANTHROPIC_API_KEY overstyrer alle andre
    // innloggingsmåter og gir en uforståelig 401 i stedet for en tydelig feil.
    if (val && !process.env[m[1]]) process.env[m[1]] = val;
  }
}

// Kjør oppgaver med et tak på hvor mange som går samtidig.
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} avsluttet med ${code}\n${err.slice(-2000)}`))
    );
  });
}

// ──────────────────────────────────────────────────── steg -1: hent ut ordene

// Klipper ut array-literalene fra index.html og evaluerer dem. Ingen duplisering
// av data, og index.html trenger ingen endring.
function sliceArray(src, declaration) {
  const start = src.indexOf(declaration);
  if (start === -1) throw new Error(`fant ikke «${declaration}» i index.html`);
  const open = src.indexOf('[', start);
  const close = src.indexOf('\n  ];', open);
  if (close === -1) throw new Error(`fant ikke slutten på «${declaration}»`);
  return src.slice(open, close + 4);
}

async function extract() {
  const src = await fs.readFile(INDEX, 'utf8');
  const words = new Function(`return ${sliceArray(src, 'const words = [')}`)();
  const verbs = new Function(`return ${sliceArray(src, 'const verbs = [')}`)();

  const entries = [];
  const seen = new Set();
  const push = (w, deck) => {
    let key = slug(w.no);
    while (seen.has(key)) key += '-2';
    seen.add(key);
    entries.push({ key, no: w.no, en: w.en, ex: w.ex ?? null, conj: w.conj ?? null, deck });
  };

  for (const w of words) push(w, w.cat || 'Andre');
  for (const v of verbs) push(v, 'Uregelrette verb');
  return entries;
}

function filterEntries(entries) {
  let out = entries;
  if (opts.only) {
    const q = opts.only.toLowerCase();
    out = out.filter((e) => (`${e.no} ${e.en}`).toLowerCase().includes(q));
  }
  if (opts.deck) {
    const q = opts.deck.toLowerCase();
    out = out.filter((e) => e.deck.toLowerCase().includes(q));
  }
  if (opts.limit) out = out.slice(0, opts.limit);
  return out;
}

// ────────────────────────────────────────────────── steg 0: historier (Claude)

const SYSTEM_PROMPT = `You write tiny Norwegian stories that drill a single target word into the memory of an English-speaking learner at A2–B1 level. The learner will hear your story read aloud, many times over, while doing something else. It has to work on the ear alone.

You receive one vocabulary entry as JSON: the Norwegian word or phrase ("no"), its English meaning ("en"), sometimes a source sentence ("ex"), and for verbs a conjugation table ("conj" with inf, pres, fort, perf).

Write ONE short story built around that word.

## Hard requirements

- Bokmål. Between four and six sentences. One concrete everyday scene with a small beginning and a small end — someone doing something somewhere, not an abstract musing.
- The target word must appear AT LEAST FOUR times, spread across different sentences. Never twice in the same clause.
- If the entry has a "conj" table, the story must use at least three of its four forms, each in a natural sentence. Spread them out: the infinitive in one sentence, the present in another, the past somewhere else. This is the point of the exercise — the listener should hear the word change shape.
- If the entry is a noun, vary its form the way ordinary Norwegian does: indefinite, definite, plural where it fits.
- Every OTHER word in the story must be high-frequency A2–B1 Norwegian. The listener is learning the target word; do not surround it with three more unknown ones.
- The story must be plainly, unmistakably true to the meaning given in "en". If the meaning is narrow or idiomatic, build the scene so the meaning is obvious from context alone.

## It will be read aloud by a speech synthesiser

- Write all numbers as words: "tre", never "3".
- No abbreviations whatsoever. Write "for eksempel", never "f.eks."; "og så videre", never "osv."; "klokka" and the hour in words, never "kl. 14".
- No parentheses, quotation marks, guillemets, colons, semicolons, asterisks, dashes used as punctuation, markdown, or emoji.
- The only punctuation you may use is the period, the comma, the question mark and the exclamation mark.
- The stories share one small cast, and you may use ONLY these names. Never invent another first name and never use a name for anyone outside this cast — other people are referred to by their role instead: naboen, læreren, sjefen, moren, en venn.
- Not every story needs a name at all. Use one or two of the cast when the scene wants a person, and leave them out when it does not.

## The cast

- **Damian**, twenty-seven, a software engineer. Quiet and soft-spoken. He dreams, he travels, he plays guitar and bass, he listens to a lot of music, and he is happiest outdoors.
- **Aleksandra**, his girlfriend, the same age. Artsy and dreamy. She does handcraft, bakes elaborate cakes, travels, cares about clothes, and loves cats.
- **Sonia**, a dog. She belongs to Damian's parents, not to Damian and Aleksandra, so she turns up when they visit them. She is five years old and full of energy.

Treat this as background, not as a checklist. A story does not have to mention anyone's job or hobby — most should not. The details are there so that when a scene needs a reason for someone to be somewhere, it is a reason that fits them: Damian on a mountain path or with a guitar, Aleksandra in the kitchen with a cake or in a fabric shop, Sonia pulling at the leash at his parents' house. Never let a character detail drag in rare vocabulary; the words around the target word stay high-frequency no matter who is in the scene.

## Style

- Ordinary Norwegian life: kitchens, buses, hytta, the shop, work, weather, the dog Sonia.
- Vary the sentence grammar around the target word so the listener hears it in different positions, not the same frame four times.
- Do not explain the word. Do not translate anything. No title, no heading, no English, no commentary.
- Reply with the story text and nothing else. No preamble, no label, no surrounding quotation marks. Your entire reply is the story.

## Examples of the register you are aiming for

Entry: {"no":"å påvirke","en":"to affect / influence","conj":{"inf":"å påvirke","pres":"påvirker","fort":"påvirket","perf":"har påvirket"}}
Story: Været påvirker humøret mitt hver eneste høst. I fjor påvirket den lange regnperioden hele familien, og vi ble sittende inne i ukevis. Damian mener at maten han spiser har påvirket søvnen hans mer enn han trodde. Jeg vil gjerne påvirke min egen hverdag litt mer, så nå går jeg en tur hver morgen.

Entry: {"no":"en mage","en":"a stomach"}
Story: Aleksandra hadde vondt i magen hele natten. Hun hadde spist altfor mye kake, og nå lå hun med en hånd på magen og klaget. Moren sa at mager blir sure av så mye sukker. Neste morgen var magen helt fin igjen, og Aleksandra spiste to brødskiver.

Entry: {"no":"å bjeffe","en":"to bark"}
Story: Sonia begynte å bjeffe klokka seks om morgenen. Hun bjeffer hver gang postbudet kommer opp trappa, og naboen synes det er slitsomt. I går bjeffet hun så lenge at Damian måtte gå ut i hagen med henne. Nå har hun bjeffet seg helt trøtt, og endelig er det stille i huset.`;

// Feil som gjelder oppsettet, ikke det enkelte ordet. Da er det ingen vits i å
// prøve de 428 andre — vi stopper hele kjøringen med én gang.
const FATAL = /credential|security token|InvalidClientTokenId|UnrecognizedClient|AccessDenied|not authorized|ResourceNotFound|ValidationException|403|could not load|region/i;

function userPrompt(entry) {
  const payload = { no: entry.no, en: entry.en };
  if (entry.ex) payload.ex = entry.ex.replace(/[«»]/g, '').replace(/\.{2,}/g, ' ').trim();
  if (entry.conj) payload.conj = entry.conj;
  return JSON.stringify(payload);
}

function entryHash(entry) {
  return hash(JSON.stringify([PROMPT_VERSION, entry.no, entry.en, entry.ex, entry.conj]));
}

// --- validering: kjøres i kode, ikke overlatt til modellen ---------------

const BANNED_ABBREV = /\b(f\.eks|osv|bl\.a|dvs|ca|kl|m\.m|jf|ift|pga)\b\.?/i;
const BANNED_CHARS = /[()«»"“”:;*_#\[\]{}<>|/\\]/;

function stemOf(word) {
  const bare = word.replace(/^(å|en|ei|et|har)\s+/i, '').trim().toLowerCase();
  if (bare.includes(' ')) return null; // flerordsuttrykk håndteres som hel frase
  return bare.length >= 4 && bare.endsWith('e') ? bare.slice(0, -1) : bare;
}

function surfaceForms(entry) {
  if (!entry.conj) return [];
  return Object.values(entry.conj)
    .map((f) => f.replace(/^(å|har)\s+/i, '').trim())
    .filter(Boolean);
}

function countTarget(story, entry) {
  const text = story.toLowerCase();
  const bare = entry.no.replace(/^(å|en|ei|et)\s+/i, '').trim().toLowerCase();

  if (bare.includes(' ')) {
    // Flerordsuttrykk: krev hele frasen — men tell de bøyde formene også.
    // Uten dem faller partikkelverb alltid igjennom: «å skifte ut» leses
    // naturlig som «skiftet ut», som ikke inneholder frasen «skifte ut».
    const needles = [...new Set([bare, ...surfaceForms(entry).map((f) => f.toLowerCase())])]
      .map((f) => f.replace(/\s+/g, ' '))
      .sort((a, b) => b.length - a.length);
    return (text.match(new RegExp(`\\b(?:${needles.map(esc).join('|')})`, 'g')) || []).length;
  }

  const stems = new Set([stemOf(entry.no), ...surfaceForms(entry).map(stemOf)].filter(Boolean));
  const alt = [...stems].sort((a, b) => b.length - a.length).map(esc).join('|');
  return (text.match(new RegExp(`\\b(?:${alt})\\w*`, 'g')) || []).length;
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formsPresent(story, entry) {
  const text = story.toLowerCase();
  return surfaceForms(entry).filter((f) =>
    new RegExp(`\\b${esc(f.toLowerCase())}\\b`).test(text)
  ).length;
}

function validateStory(story, entry) {
  const problems = [];
  const s = story.trim();

  if (BANNED_CHARS.test(s)) problems.push('inneholder tegn som ikke leses godt opp');
  if (BANNED_ABBREV.test(s)) problems.push('inneholder forkortelse');
  if (/\d/.test(s)) problems.push('inneholder siffer');

  const sentences = s.split(/[.!?]+/).map((x) => x.trim()).filter(Boolean).length;
  if (sentences < 4) problems.push(`bare ${sentences} setninger`);
  if (sentences > 7) problems.push(`${sentences} setninger, for langt`);

  const hits = countTarget(s, entry);
  if (hits < 4) problems.push(`ordet forekommer ${hits} ganger, trenger fire`);

  if (entry.conj) {
    const forms = formsPresent(s, entry);
    if (forms < 3) problems.push(`bare ${forms} av fire bøyningsformer brukt`);
  }

  return problems;
}

// --- generering ---------------------------------------------------------

let anthropic = null;
async function claude() {
  if (anthropic) return anthropic;
  const { default: AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk');
  // Standard AWS-legitimasjonskjede: AWS_ACCESS_KEY_ID/SECRET i .env, en profil
  // i ~/.aws, eller en instansrolle. Samme som animalhotels-browser.
  anthropic = new AnthropicBedrock({ awsRegion: awsRegion() });
  return anthropic;
}

// Bedrock kjører Claude via InvokeModel, og eldre inferensprofiler tar ikke
// nødvendigvis imot output_config. Vi prøver med, og slår det av for resten av
// kjøringen hvis tjenesten avviser det.
let effortSupported = true;

async function generateStory(entry, attempt, lastProblems) {
  const client = await claude();

  let content = userPrompt(entry);
  if (attempt > 0) {
    content +=
      `\n\nYour previous attempt was rejected by an automatic check: ${lastProblems.join('; ')}. ` +
      `Write a new story that fixes this. Keep every other requirement.`;
  }

  // Ingen fallbacks-parameter her: den finnes ikke på Bedrock.
  const body = {
    model: modelId(),
    // Tenkingen deler budsjett med svaret, så vi gir god klaring.
    // Ubrukte tokens koster ingenting.
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  };
  if (effortSupported) body.output_config = { effort: effort() };

  let res;
  try {
    res = await client.messages.create(body);
  } catch (err) {
    if (effortSupported && /output_config|effort|unexpected|unsupported/i.test(err.message)) {
      console.log('  (modellen tar ikke imot output_config — fortsetter uten)');
      effortSupported = false;
      delete body.output_config;
      res = await client.messages.create(body);
    } else {
      throw err;
    }
  }

  if (res.stop_reason === 'refusal') {
    throw new Error(`avslått av modellen (${res.stop_details?.category ?? 'ukjent'})`);
  }
  if (res.stop_reason === 'max_tokens') {
    throw new Error('svaret ble kuttet — øk max_tokens');
  }

  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('tomt svar');

  return { story: cleanStory(text), usage: res.usage };
}

// Svaret er ren tekst, ikke JSON — eldre Bedrock-profiler støtter ikke
// structured outputs. Valideringen under fanger opp resten.
function cleanStory(text) {
  return text
    .trim()
    .replace(/^(historie|story|svar)\s*:\s*/i, '')
    .replace(/^["'«»]+|["'«»]+$/g, '')
    .trim();
}

async function stageStories(entries) {
  const store = await readJson(STORIES, {});
  const todo = entries.filter((e) => {
    const have = store[e.key];
    if (!have) return true;
    if (have.locked) return false;
    return opts.force || have.hash !== entryHash(e);
  });

  console.log(`historier: ${entries.length} ord, ${todo.length} må skrives`);
  if (!todo.length) return store;

  if (opts.dry) {
    for (const e of todo.slice(0, 10)) {
      console.log(`\n─── ${e.no} ───\n${userPrompt(e)}`);
    }
    console.log(`\n(${todo.length} prompter, viser de ti første. Ingen API-kall gjort.)`);
    return store;
  }

  let done = 0, failed = 0;
  const totals = { input: 0, cacheRead: 0, output: 0 };

  await pool(todo, opts.concurrency, async (entry) => {
    let problems = [];
    let lastStory = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { story, usage } = await generateStory(entry, attempt, problems);
        totals.input += usage.input_tokens ?? 0;
        totals.cacheRead += usage.cache_read_input_tokens ?? 0;
        totals.output += usage.output_tokens ?? 0;
        lastStory = story;

        problems = validateStory(story, entry);
        if (!problems.length) {
          store[entry.key] = { no: entry.no, en: entry.en, story, hash: entryHash(entry), locked: false };
          console.log(`  ✓ ${entry.no}`);
          done++;
          return;
        }
      } catch (err) {
        if (FATAL.test(err.message)) throw err; // oppsettfeil — stopp alt
        if (/rate|429|throttl|overload|529/i.test(err.message) && attempt < 2) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        problems = [err.message];
      }
    }

    // Behold siste forsøk selv om det ble avvist — det er lettere å rette for
    // hånd enn å skrive fra bunnen, og --print viser det sammen med feilen.
    store[entry.key] = {
      no: entry.no, en: entry.en,
      story: lastStory ?? store[entry.key]?.story ?? null,
      hash: entryHash(entry), locked: false, needsReview: problems,
    };
    console.log(`  ! ${entry.no} — ${problems.join('; ')}`);
    failed++;
  });

  await fs.writeFile(STORIES, JSON.stringify(sortKeys(store), null, 2) + '\n');
  console.log(
    `historier: ${done} skrevet, ${failed} trenger gjennomsyn\n` +
    `tokens: ${totals.input} inn, ${totals.output} ut  (${modelId()})`
  );
  return store;
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

// ──────────────────────────────────────────────────────── steg 1: klipp (Azure)

function xml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function cleanExample(ex) {
  return ex.replace(/[«»]/g, '').replace(/^\s*\.{2,}\s*/, '').replace(/\s*\.{2,}\s*$/, '')
    .replace(/\.{2,}/g, ', ').replace(/\s+/g, ' ').trim();
}

function formsText(entry) {
  if (!entry.conj) return xml(entry.no);
  const { inf, pres, fort, perf } = entry.conj;
  return [inf, pres, fort, perf].map(xml).join(' <break time="400ms"/> ');
}

function buildSsml(entry, story) {
  const parts = [`<prosody rate="${opts.rate}">${formsText(entry)}</prosody>`];

  if (opts.withExample && entry.ex) {
    parts.push('<break time="600ms"/>', `<prosody rate="${opts.rate}">${xml(cleanExample(entry.ex))}</prosody>`);
  }
  if (story) {
    parts.push('<break time="700ms"/>', `<prosody rate="${opts.storyRate || opts.rate}">${xml(story)}</prosody>`);
  }

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="nb-NO">` +
    `<voice name="${NB_VOICE}">${parts.join('')}</voice>` +
    // Tenkepausen må ligge inne i <voice>. Azure svarer 400 (med tom kropp) på
    // <break> som direkte barn av <speak>.
    `<voice name="${EN_VOICE}"><break time="${opts.pause}ms"/>${xml(entry.en)}</voice>` +
    `</speak>`;
}

function announceSsml(text) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="nb-NO">` +
    `<voice name="${NB_VOICE}">${xml(text)}</voice></speak>`;
}

function azureConfig() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    throw new Error('AZURE_SPEECH_KEY og AZURE_SPEECH_REGION må ligge i .env');
  }
  return { key, region };
}

async function listVoices() {
  const { key, region } = azureConfig();
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': key },
  });
  if (!res.ok) throw new Error(`stemmeliste feilet: ${res.status}`);
  for (const v of await res.json()) {
    if (v.Locale.startsWith('nb-') || v.Locale.startsWith('en-GB')) {
      console.log(`${v.ShortName.padEnd(28)} ${v.Locale}  ${v.Gender}`);
    }
  }
}

async function synthesize(ssml, outPath) {
  if (opts.fakeAudio) {
    // Pipetone med omtrent samme lengde som talen ville hatt, så episode-
    // inndelingen kan testes uten å bruke av Azure-kvoten.
    const seconds = Math.max(2, Math.min(45, ssml.replace(/<[^>]+>/g, '').length / 15));
    await run('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds.toFixed(2)}`,
      '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-ac', '1', outPath,
    ]);
    return;
  }

  const { key, region } = azureConfig();
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': SPEECH_FORMAT,
        'User-Agent': 'ordboken-podkast',
      },
      body: ssml,
    });

    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Azure ${res.status}: ${(await res.text()).slice(0, 300)}`);

    await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return;
  }
  throw new Error('Azure svarte ikke etter fire forsøk');
}

function clipPathFor(ssml, key) {
  return path.join(CLIPS, `${key}-${hash(ssml)}.mp3`);
}

async function stageClips(entries, store, render) {
  await fs.mkdir(CLIPS, { recursive: true });

  const jobs = [];
  for (const entry of entries) {
    const record = store[entry.key];
    if (!record?.story) {
      console.log(`  – hopper over ${entry.no} (ingen historie ennå)`);
      continue;
    }
    const ssml = buildSsml(entry, record.story);
    jobs.push({ entry, ssml, file: clipPathFor(ssml, entry.key) });
  }

  const missing = [];
  for (const job of jobs) if (!(await exists(job.file))) missing.push(job);

  const chars = missing.reduce((n, j) => n + j.ssml.replace(/<[^>]+>/g, '').length, 0);
  console.log(`klipp: ${jobs.length} ord, ${missing.length} må leses inn (~${chars} tegn)`);

  if (missing.length && render && !opts.dry) {
    let n = 0;
    await pool(missing, opts.concurrency, async (job) => {
      await synthesize(job.ssml, job.file);
      console.log(`  ✓ ${job.entry.no}  (${++n}/${missing.length})`);
    });
  } else if (missing.length && !render) {
    console.log('  (hopper over innlesing — kjør uten --episodes-only for å lese dem inn)');
  }

  if (opts.prune) await pruneClips(jobs.map((j) => path.basename(j.file)));

  // Episodesteget kan bare bruke klipp som faktisk finnes på disk.
  const ready = [];
  for (const job of jobs) if (await exists(job.file)) ready.push(job);
  return ready;
}

async function pruneClips(keep) {
  const keepSet = new Set(keep);
  let removed = 0;
  for (const file of await fs.readdir(CLIPS)) {
    if (file.endsWith('.mp3') && !keepSet.has(file) && !file.startsWith('intro-')) {
      await fs.unlink(path.join(CLIPS, file));
      console.log(`  slettet ${file}`);
      removed++;
    }
  }
  console.log(`prune: ${removed} klipp fjernet`);
}

// ─────────────────────────────────────────────────── steg 2: episoder (ffmpeg)

async function durationOf(file, cache) {
  if (cache[file] != null) return cache[file];
  const out = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  return (cache[file] = parseFloat(out.trim()));
}

async function silenceFile(ms) {
  await fs.mkdir(SILENCE, { recursive: true });
  const file = path.join(SILENCE, `${ms}.mp3`);
  if (!(await exists(file))) {
    await run('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
      '-t', String(ms / 1000),
      '-c:a', 'libmp3lame', '-b:a', '48k', file,
    ]);
  }
  return file;
}

// Introen leses opp, så tallene må skrives ut med bokstaver.
function norwegianNumber(n) {
  const ones = ['null', 'én', 'to', 'tre', 'fire', 'fem', 'seks', 'sju', 'åtte', 'ni'];
  const teens = ['ti', 'elleve', 'tolv', 'tretten', 'fjorten', 'femten',
    'seksten', 'sytten', 'atten', 'nitten'];
  const tens = ['', '', 'tjue', 'tretti', 'førti', 'femti', 'seksti', 'sytti', 'åtti', 'nitti'];

  if (n < 10) return ones[n];
  if (n < 20) return teens[n - 10];
  if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ones[n % 10] : '');
  if (n < 1000) {
    const rest = n % 100;
    return `${n < 200 ? 'hundre' : ones[Math.floor(n / 100)] + 'hundre'}${rest ? ' og ' + norwegianNumber(rest) : ''}`;
  }
  return String(n);
}

// Skriver historiene inn i den genererte blokka i index.html. Bare historier
// som har gått gjennom valideringen tas med — de med needsReview hoppes over,
// på samme måte som i lydsteget.
const SYNC_START = '  // ── historier: generert, ikke rediger for hånd';
const SYNC_END = '  // ── slutt historier';

// Leser ord/ og gir tilbake { nøkkel: sti } for de klippene som faktisk ligger
// der. Nøkkelen er den samme slug-en som historiene bruker, så appen slår opp
// begge deler med storyKey(). Filnavnet er «NNN ord.mp3»; nummeret er bare
// sorteringshjelp for avspillere og strippes bort her.
async function scanWordAudio() {
  let decks;
  try {
    decks = await fs.readdir(WORDS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }

  const out = {};
  for (const deck of decks) {
    if (!deck.isDirectory()) continue;
    const files = await fs.readdir(path.join(WORDS_DIR, deck.name));
    for (const file of files.sort()) {
      if (!file.endsWith('.mp3')) continue;
      const word = file.slice(0, -4).replace(/^\d+\s+/, '');
      out[slug(word)] = `${path.basename(WORDS_DIR)}/${deck.name}/${file}`;
    }
  }
  return out;
}

async function syncApp() {
  const store = await readJson(STORIES, {});
  const audio = await scanWordAudio();
  const src = await fs.readFile(INDEX, 'utf8');

  const start = src.indexOf(SYNC_START);
  const end = src.indexOf(SYNC_END);
  if (start === -1 || end === -1) {
    throw new Error('fant ikke historie-blokka i index.html — er markørene fjernet?');
  }
  const lineEnd = src.indexOf('\n', src.indexOf('\n', end) - 1);

  const usable = Object.entries(store)
    .filter(([, v]) => v.story && !(v.needsReview?.length))
    .sort(([a], [b]) => a.localeCompare(b, 'no'));

  const body = usable.length
    ? usable.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v.story)},`).join('\n')
    : null;

  const clips = Object.entries(audio).sort(([a], [b]) => a.localeCompare(b, 'no'));
  const clipBody = clips.length
    ? clips.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')
    : null;

  const block =
    `${SYNC_START} ───────────────────────────\n` +
    `  // Skriv om med:  node tools/build-podcast.mjs --sync-app\n` +
    `  // Kilden er stories.json; rett teksten der og kjør kommandoen på nytt.\n` +
    (body ? `  const stories = {\n${body}\n  };\n` : `  const stories = {};\n`) +
    `\n` +
    `  // Lydklipp fra ord/ — bare de som faktisk ligger på disk. Kjør\n` +
    `  // --per-word for å lage dem, og --sync-app på nytt for å ta dem inn.\n` +
    (clipBody ? `  const clips = {\n${clipBody}\n  };\n` : `  const clips = {};\n`) +
    `${SYNC_END} ──────────────────────────────────────────────────────`;

  await fs.writeFile(INDEX, src.slice(0, start) + block + src.slice(lineEnd));

  const skipped = Object.keys(store).length - usable.length;
  console.log(
    `index.html: ${usable.length} historier skrevet inn` +
    (skipped ? ` (${skipped} hoppet over — mangler tekst eller trenger gjennomsyn)` : '')
  );
  console.log(`index.html: ${clips.length} lydklipp koblet på`);
}

// Alternativ til steg 2: legg klippene som de er i ord/, ett spor per ord.
// Klippene i .cache/clips heter <nøkkel>-<hash>.mp3 og ryddes av --prune;
// ord/ er stabil og lesbar, med nummer foran så avspilleren holder rekkefølgen.
async function stagePerWord(jobs) {
  await fs.mkdir(WORDS_DIR, { recursive: true });

  const byDeck = new Map();
  for (const job of jobs) {
    if (!byDeck.has(job.entry.deck)) byDeck.set(job.entry.deck, []);
    byDeck.get(job.entry.deck).push(job);
  }

  let written = 0;
  for (const deck of DECK_ORDER) {
    const list = byDeck.get(deck);
    if (!list?.length) continue;

    const dir = path.join(WORDS_DIR, slug(deck));
    await fs.mkdir(dir, { recursive: true });

    let track = 0;
    for (const job of list) {
      track++;
      const name = `${String(track).padStart(3, '0')} ${job.entry.no}.mp3`;
      await fs.copyFile(job.file, path.join(dir, name));
      written++;
    }
  }

  console.log(`ord: ${written} filer i ${path.relative(ROOT, WORDS_DIR)}/`);
}

async function stageEpisodes(jobs) {
  await fs.mkdir(EPISODES, { recursive: true });
  const durations = await readJson(path.join(CACHE, 'durations.json'), {});

  // Grupper etter kortstokk, behold kilderekkefølgen, del i ~15-minutters biter.
  const byDeck = new Map();
  for (const job of jobs) {
    if (!byDeck.has(job.entry.deck)) byDeck.set(job.entry.deck, []);
    byDeck.get(job.entry.deck).push(job);
  }

  const episodes = [];
  for (const deck of DECK_ORDER) {
    const list = byDeck.get(deck);
    if (!list?.length) continue;

    const lengths = [];
    let deckSeconds = 0;
    for (const job of list) {
      const d = (await durationOf(job.file, durations)) + opts.gap / 1000;
      lengths.push(d);
      deckSeconds += d;
    }

    // Fordel jevnt i stedet for å fylle opp til taket og la en stump bli igjen:
    // to episoder på 12 minutter er bedre enn én på 15 og én på to.
    const partCount = Math.max(1, Math.ceil(deckSeconds / EPISODE_MAX_SECONDS));
    const target = deckSeconds / partCount;

    let part = [], seconds = 0;
    const flush = () => {
      if (part.length) episodes.push({ deck, items: part, seconds });
      part = []; seconds = 0;
    };
    for (const [i, job] of list.entries()) {
      const remainingParts = partCount - episodes.filter((e) => e.deck === deck).length;
      if (part.length && remainingParts > 1 && seconds + lengths[i] / 2 > target) flush();
      part.push(job);
      seconds += lengths[i];
    }
    flush();
  }
  await fs.writeFile(path.join(CACHE, 'durations.json'), JSON.stringify(durations));

  const partsPerDeck = new Map();
  for (const ep of episodes) partsPerDeck.set(ep.deck, (partsPerDeck.get(ep.deck) ?? 0) + 1);

  const gap = await silenceFile(opts.gap);
  const introGap = await silenceFile(1200);
  const counters = new Map();
  let track = 0;

  console.log(`episoder: ${episodes.length} filer`);

  for (const ep of episodes) {
    const partNo = (counters.get(ep.deck) ?? 0) + 1;
    counters.set(ep.deck, partNo);
    const total = partsPerDeck.get(ep.deck);
    const deckTitle = DECK_TITLES[ep.deck] ?? ep.deck;
    const title = total > 1 ? `${deckTitle} del ${partNo}` : deckTitle;
    track++;

    const spoken =
      `Ordboken. ${deckTitle}${total > 1 ? `, del ${norwegianNumber(partNo)}` : ''}. ` +
      `${norwegianNumber(ep.items.length)} ord.`;
    const introSsml = announceSsml(spoken);
    const intro = path.join(CLIPS, `intro-${hash(introSsml)}.mp3`);
    if (!(await exists(intro)) && !opts.dry) await synthesize(introSsml, intro);

    const outFile = path.join(EPISODES, `${String(track).padStart(2, '0')} ${title}.mp3`);
    if (opts.dry) {
      console.log(`  ${path.basename(outFile)} — ${ep.items.length} ord, ${Math.round(ep.seconds / 60)} min`);
      continue;
    }

    // Concat-demuxer over separat kodede mp3-er gir hakk og driv hvis man
    // kopierer strømmen, så vi koder om én gang til slutt.
    const listFile = path.join(CACHE, 'concat.txt');
    const lines = [intro, introGap];
    for (const job of ep.items) lines.push(job.file, gap);
    await fs.writeFile(listFile, lines.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));

    await run('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-ac', '1',
      '-metadata', `title=${title}`,
      '-metadata', 'album=Ordboken',
      '-metadata', 'artist=Ordboken',
      '-metadata', 'genre=Speech',
      '-metadata', `track=${track}`,
      outFile,
    ]);
    console.log(`  ✓ ${path.basename(outFile)} — ${ep.items.length} ord, ${Math.round(ep.seconds / 60)} min`);
  }
}

// ────────────────────────────────────────────────────────────────────── main

async function main() {
  await loadEnv();
  await fs.mkdir(CACHE, { recursive: true });

  if (opts.listVoices) return listVoices();
  if (opts.syncApp) return syncApp();

  const all = await extract();
  const entries = filterEntries(all);
  console.log(`ordboken: ${all.length} ord totalt, ${entries.length} i denne kjøringen\n`);

  if (opts.print) {
    const store = await readJson(STORIES, {});
    for (const e of entries) {
      const r = store[e.key];
      if (!r) continue;
      console.log(`\n─── ${e.no}  (${e.en}) ───`);
      console.log(r.needsReview ? `  ! ${r.needsReview.join('; ')}` : '');
      console.log(r.story ?? '(ingen historie)');
    }
    return;
  }

  const doStories = !opts.audioOnly && !opts.episodesOnly;
  const doClips = !opts.storiesOnly && !opts.episodesOnly;
  const doEpisodes = !opts.storiesOnly && !opts.audioOnly;

  const store = doStories ? await stageStories(entries) : await readJson(STORIES, {});
  if (!doClips && !doEpisodes) return;

  const jobs = await stageClips(entries, store, doClips);
  if (doEpisodes && jobs.length) {
    await (opts.perWord ? stagePerWord(jobs) : stageEpisodes(jobs));
  }
}

// Eksporteres så valideringen kan testes uten å kjøre hele bygget.
export { validateStory, countTarget, formsPresent, buildSsml, extract, slug };

if (import.meta.filename === process.argv[1]) {
  main().catch((err) => {
    console.error(`\nfeil: ${err.message}`);
    process.exit(1);
  });
}
