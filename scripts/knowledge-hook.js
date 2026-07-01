#!/usr/bin/env node
import { existsSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { join, relative } from 'path';

function validEnv(name) {
  const v = process.env[name];
  return v && !v.includes('${') ? v : '';
}

let input = '';
const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  input = chunks.join('');
  run();
});

const DIACRITICS = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => DIACRITICS[ch] || ch);
}

function readHead(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function parseFrontmatterKeywords(head) {
  if (!head.startsWith('---')) return [];
  const end = head.indexOf('\n---', 3);
  if (end === -1) return [];
  const block = head.slice(0, end);
  const m = block.match(/^keywords:\s*\[([^\]]*)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((k) => normalizeText(k.trim().replace(/^["']|["']$/g, '')))
    .filter(Boolean);
}

function walkMarkdownFiles(dir, depth, out) {
  if (depth > 5 || out.length >= 500) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
      if (out.length >= 500) return;
    }
  }
}

function matchKnowledgeFiles(promptText) {
  const root = validEnv('MARKETING_KNOWLEDGE_DIR');
  if (!root || !existsSync(root)) return [];

  const files = [];
  walkMarkdownFiles(root, 0, files);
  if (!files.length) return [];

  const normalizedPrompt = normalizeText(promptText);
  if (!normalizedPrompt.trim()) return [];

  const matches = [];
  for (const file of files) {
    const keywords = parseFrontmatterKeywords(readHead(file, 2048));
    const hit = keywords.find((kw) => kw.length > 2 && normalizedPrompt.includes(kw));
    if (hit) matches.push({ path: relative(root, file).replace(/\\/g, '/'), keyword: hit });
    if (matches.length >= 3) break;
  }
  return matches;
}

function run() {
  let promptText = '';
  try {
    const parsed = JSON.parse(input);
    promptText = String(parsed.prompt ?? parsed.message ?? parsed.text ?? '');
  } catch {}

  const matches = promptText ? matchKnowledgeFiles(promptText) : [];
  if (matches.length) {
    const lines = matches.map((m) => `- ${m.path} (dopasowano: "${m.keyword}")`).join('\n');
    const additionalContext = `Dostępna wiedza marketingowa powiązana z tym promptem (przeczytaj wskazane pliki w MARKETING_KNOWLEDGE_DIR, jeśli chcesz je wykorzystać):\n${lines}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    }));
  }

  process.exit(0);
}
