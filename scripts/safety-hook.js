#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

const mode = process.argv[2];
if (!mode) {
  console.error('Usage: google-ads-baby-safety-hook <pre-tool|user-submit> [dataDir]');
  process.exit(2);
}

function validEnv(name) {
  const v = process.env[name];
  return v && !v.includes('${') ? v : '';
}

function validArg(v) {
  return v && !v.includes('${') ? v : '';
}

const stateDir = validArg(process.argv[3])
  || validEnv('GOOGLE_ADS_BABY_DATA')
  || join(homedir() || tmpdir(), '.google-ads-baby');
mkdirSync(stateDir, { recursive: true });

const STATE_FILE = join(stateDir, '.gads-confirm-state');
const SAFE_WORD_FILE = join(stateDir, '.gads-safe-word');
const CONFIG_FILE = join(stateDir, 'config.json');

function readConfig(key) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return String(cfg[key] || '');
  } catch {
    return '';
  }
}

function readFile(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function readState() {
  const raw = readFile(STATE_FILE);
  if (!raw) return { state: '', ts: 0 };
  const [state, ts] = raw.trim().split(':');
  return { state, ts: parseInt(ts, 10) || 0 };
}

function writeState(state) {
  writeFileSync(STATE_FILE, `${state}:${Math.floor(Date.now() / 1000)}`);
}

const savedSafetyLevel = readConfig('safetyLevel');
const savedStateTtl = readConfig('confirmStateTtlSeconds');
const safetyLevel = process.env.GOOGLE_ADS_SAFETY_LEVEL || savedSafetyLevel || 'standard';

let stateTtl = parseInt(process.env.GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS || savedStateTtl, 10);
if (isNaN(stateTtl)) {
  if (safetyLevel === 'strict') stateTtl = 300;
  else if (safetyLevel === 'off') stateTtl = 0;
  else stateTtl = 3600;
}

let input = '';
const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  input = chunks.join('');
  run();
});

function extractToolName() {
  try {
    return JSON.parse(input).tool_name || '';
  } catch {
    const m = input.match(/"tool_name"\s*:\s*"([^"]*)"/);
    return m ? m[1] : '';
  }
}

function extractSafeWord() {
  try {
    const parsed = JSON.parse(input);
    return String(parsed.tool_input?.safe_word || '');
  } catch {
    const m = input.match(/"safe_word"\s*:\s*"([^"]*)"/);
    return m ? m[1] : '';
  }
}

function safeWordPresent(word) {
  if (!word) return false;
  let text = input;
  try {
    const parsed = JSON.parse(input);
    text = String(parsed.prompt ?? parsed.message ?? parsed.text ?? input);
  } catch {}
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, 'i');
  return re.test(text);
}

function run() {
  if (mode === 'pre-tool') {
    const toolName = extractToolName();

    if (/google[-_]ads__prepare_/.test(toolName)) {
      writeState('pending');
      const safeWord = extractSafeWord();
      if (safeWord) writeFileSync(SAFE_WORD_FILE, safeWord);
      process.exit(0);
    }

    if (/google[-_]ads__confirm_mutation/.test(toolName)) {
      if (safetyLevel === 'off' || process.env.GOOGLE_ADS_YOLO === '1') {
        try { unlinkSync(STATE_FILE); } catch {}
        process.exit(0);
      }

      if (!existsSync(STATE_FILE)) {
        process.stdout.write('{"error":"Brak operacji do potwierdzenia. Najpierw wywołaj prepare_*."}');
        process.exit(2);
      }

      const { state, ts } = readState();

      if (stateTtl !== 0 && ts) {
        const age = Math.floor(Date.now() / 1000) - ts;
        if (age > stateTtl) {
          try { unlinkSync(STATE_FILE); } catch {}
          process.stdout.write('{"error":"Potwierdzenie wygasło. Przygotuj operację ponownie za pomocą prepare_*."}');
          process.exit(2);
        }
      }

      if (state !== 'user-confirmed') {
        process.stdout.write('{"error":"Wymagana odpowiedź użytkownika przed potwierdzeniem. Zapytaj użytkownika i poczekaj na odpowiedź."}');
        process.exit(2);
      }

      process.exit(0);
    }
  }

  if (mode === 'user-submit') {
    if (existsSync(STATE_FILE)) {
      const { state } = readState();
      if (state === 'pending') {
        const safeWord = readFile(SAFE_WORD_FILE).trim();
        if (!safeWord || safeWordPresent(safeWord)) {
          writeState('user-confirmed');
        }
      }
    }
    process.exit(0);
  }

  process.exit(0);
}
