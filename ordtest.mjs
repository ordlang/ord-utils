#!/usr/bin/env node
// ordtest — extract, lint and run the tests in the Ord specs (https://github.com/ordlang/ord):
// Ord_Specification.md, Test_format.md, Semantics.md, JSON_mapping.md and CSV_mapping.md.
// The test format is Test_format.md, part B. No dependencies. Node 18 or later.
//
//   ordtest list     SPEC                      number, line, kind and rules of each test
//   ordtest extract  SPEC                      all tests as JSON
//   ordtest lint     SPEC                      check the tests themselves: blocks, dumps, ranges, JSON
//   ordtest coverage SPEC                      rules that no test names, by letter
//   ordtest run      SPEC [--dump CMD] [--fmt CMD] [--from-json CMD] [--to-json CMD]
//                         [--from-csv CMD] [--to-csv CMD] [--graph CMD] [--only ID]...
//
// run gives each input on standard input to the command for the test's kind and compares
// standard output with the expected output (T7): byte for byte, or as JSON values for
// to-json tests. Commands that print a dump (--dump, --from-json, --from-csv) get
// `--ranges` and `--labels` appended when the test has those options, and --fmt gets
// `--labels` and, with it, `--today` and the test's date and time, as in
// `--today 2026-10-15T14:30` (T4). With --fmt, every Ord input is also checked for stable
// writing (T5).
// Tests whose command isn't given are skipped. --only keeps tests that show the given
// rule ID or have the given number; it can be repeated.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const QUOTES = ['`', '"'];
const KINDS = ['fmt', 'from-json', 'to-json', 'from-csv', 'to-csv', 'graph'];
const OPTIONS = new Set(['ranges', 'labels', ...KINDS]);
const RULE_ID = /^[A-Z]\d+[a-z]?(\.\d+)?$/;
const TODAY = /^today:(\d{4}-\d{2}-\d{2})$/;      // T4
const DEFAULT_TODAY = '2026-10-15';
const TIME = '14:30';
const DUMP_KINDS = new Set(['dump', 'from-json', 'from-csv']);   // expected output is a dump
const ORD_INPUT = new Set(['dump', 'fmt', 'to-json', 'to-csv']); // input is Ord

// ---------- reading the spec (C1, C2, C29, C31) ----------

function splitLines(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const indentOf = (line) => /^[ \t]*/.exec(line)[0];

// A block opens with a fence of three or more backticks and no backtick after it, and closes
// at a line of at least as many backticks (C29).
function opener(line) {
  const indent = indentOf(line);
  const rest = line.slice(indent.length);
  const fence = /^`{3,}/.exec(rest)?.[0];
  if (!fence || rest.slice(fence.length).includes('`')) return null;
  return { fence: fence.length, indent: indent.length, info: rest.slice(fence.length) };
}

function closes(line, fence) {
  const rest = line.slice(indentOf(line).length);
  let n = 0;
  while (rest[n] === '`') n++;
  return n >= fence && /^[ \t]*$/.test(rest.slice(n));
}

function stripIndent(line, n) {
  let i = 0;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

// T3: → is a tab, ␣ a space and ⟨U+XXXX⟩ that character, in inputs and in expected output other than dumps.
const visible = (s) => s.replace(/→/g, '\t').replace(/␣/g, ' ').replace(/⟨U\+([0-9A-F]{4,6})⟩/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));

function extract(text) {
  const lines = splitLines(text);
  const tests = [];
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    const op = opener(lines[i]);
    if (!op) continue;
    let j = i + 1;
    while (j < lines.length && !closes(lines[j], op.fence)) j++;
    const words = op.info.trim().split(/[ \t]+/).filter(Boolean);
    if (words[0] === 'example') {
      const line = i + 1;
      const body = lines.slice(i + 1, j).map((l) => stripIndent(l, op.indent));
      const dot = body.indexOf('.');
      const options = [];
      const rules = [];
      let today = DEFAULT_TODAY;
      for (const w of words.slice(1)) {
        const td = TODAY.exec(w);
        if (td) { today = td[1]; options.push(w); }
        else if (OPTIONS.has(w)) options.push(w);
        else if (RULE_ID.test(w)) rules.push(w);
        else problems.push(`line ${line}: unknown word "${w}" in the info string (T1)`);
      }
      if (j >= lines.length) problems.push(`line ${line}: test block is never closed`);
      const kinds = options.filter((o) => KINDS.includes(o));
      if (kinds.length > 1) problems.push(`line ${line}: more than one of ${kinds.join(', ')} (T4)`);
      const kind = kinds[0] || 'dump';
      if (dot < 0) {
        problems.push(`line ${line}: no line that is exactly "." (T2)`);
      } else {
        const input = body.slice(0, dot).map(visible);
        const expected = body.slice(dot + 1).map(DUMP_KINDS.has(kind) ? (l) => l : visible);
        tests.push({
          number: tests.length + 1,
          line,
          options,
          rules,
          kind,
          today,
          input: input.map((l) => l + '\n').join(''),
          expected: expected.map((l) => l + '\n').join(''),
        });
      }
    }
    i = j;
  }
  return { tests, problems };
}

// ---------- dump strings (C47, D8) ----------

function uEsc(cp) {
  const hex = (n) => '\\u' + n.toString(16).padStart(4, '0');
  if (cp <= 0xffff) return hex(cp);
  const v = cp - 0x10000;
  return hex(0xd800 + (v >> 10)) + hex(0xdc00 + (v & 0x3ff));
}

const SHORT = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function canon(s) {
  let out = '"';
  for (const ch of s) {
    if (SHORT[ch]) out += SHORT[ch];
    else if (/[\p{Cc}\p{Cf}]/u.test(ch) || (ch !== ' ' && /\p{White_Space}/u.test(ch))) out += uEsc(ch.codePointAt(0));
    else out += ch;
  }
  return out + '"';
}

// Reads a JSON string token at the start of s. Returns [token, value, rest] or null.
function readString(s) {
  if (s[0] !== '"') return null;
  let i = 1;
  while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
  if (i >= s.length) return null;
  const token = s.slice(0, i + 1);
  try {
    return [token, JSON.parse(token), s.slice(i + 1)];
  } catch {
    return null;
  }
}

// ---------- lint (Test format, part A) ----------

function parseElem(text) {
  // Returns { type, ...fields, range } or { error }.
  let rest = text;
  const take = (re) => {
    const m = re.exec(rest);
    if (!m) return null;
    rest = rest.slice(m[0].length);
    return m;
  };
  const takeText = () => {
    const quoted = !!take(/^quoted /);
    const s = readString(rest);
    if (!s) return null;
    rest = s[2];
    return { quoted, token: s[0], value: s[1] };
  };
  const e = {};
  if (take(/^node/)) {
    e.type = 'node';
    if (take(/^ empty/)) e.label = 'empty';
    else if (rest.startsWith(' ') && !rest.startsWith(' @')) {
      rest = rest.slice(1);
      e.text = takeText();
      if (!e.text) return { error: 'bad label string' };
    } else e.anonymous = true;
  } else if (take(/^listnode/)) {
    e.type = 'listnode';
  } else if (take(/^field /)) {
    e.type = 'field';
    const s = readString(rest);
    if (!s) return { error: 'bad key string' };
    e.key = { token: s[0], value: s[1] };
    rest = s[2];
    if (take(/^ list/)) e.list = true;
    const m = take(/^ (inline|embedded)/);
    if (m) e.from = m[1];
  } else if (take(/^label /)) {
    e.type = 'label';
    const s = readString(rest);
    if (!s) return { error: 'bad label string' };
    e.text = { token: s[0], value: s[1] };
    rest = s[2];
  } else if (take(/^empty/)) {
    e.type = 'empty';
  } else {
    e.type = 'item';
    e.text = takeText();
    if (!e.text) return { error: 'unknown element' };
    const m = take(/^ ([\p{L}\p{N}_-]+)/u);
    if (m) e.name = m[1];
  }
  const r = take(/^ @(\d+):(\d+)-(\d+):(\d+)/);
  if (r) e.range = r.slice(1, 5).map(Number);
  if (rest !== '') return { error: `unexpected "${rest}"` };
  return e;
}

function lintDump(test) {
  const out = [];
  const say = (n, msg) => out.push(`test ${test.number} (line ${test.line}), dump line ${n}: ${msg}`);
  const lines = test.expected.split('\n');
  lines.pop();
  if (lines[0] !== 'root') say(1, 'first line must be "root" (D2)');
  const src = test.input.split('\n').map((l) => Array.from(l));
  const ranges = test.options.includes('ranges');
  const labels = test.options.includes('labels');
  let depth = 0;
  let diags = false;
  let lastDiag = null;
  const stack = [];
  for (let n = 2; n <= lines.length; n++) {
    const line = lines[n - 1];
    if (/[ \t]$/.test(line)) say(n, 'trailing whitespace (D1)');
    if (line.startsWith('! ')) {
      diags = true;
      const m = /^! ([A-Za-z0-9.]+) (\d+):(\d+)$/.exec(line);
      if (!m) { say(n, 'bad diagnostic line (D7)'); continue; }
      const key = [Number(m[2]), Number(m[3]), m[1]];
      if (lastDiag && (key[0] < lastDiag[0] || (key[0] === lastDiag[0] && (key[1] < lastDiag[1] || (key[1] === lastDiag[1] && key[2] < lastDiag[2])))))
        say(n, 'diagnostics not sorted (D7)');
      lastDiag = key;
      continue;
    }
    if (diags) { say(n, 'element after a diagnostic (D7)'); continue; }
    const ind = /^ */.exec(line)[0].length;
    if (ind === 0 || ind % 2) { say(n, 'indent must be a positive multiple of two (D2)'); continue; }
    const d = ind / 2;
    if (d > depth + 1) say(n, 'indented more than one level below the line above (D2)');
    depth = d;
    const e = parseElem(line.slice(ind));
    if (e.error) { say(n, e.error); continue; }
    stack[d] = e;
    stack.length = d + 1;
    for (const t of [e.text, e.key]) {
      if (t && canon(t.value) !== t.token) say(n, `string ${t.token} is not in canonical form, expected ${canon(t.value)} (C47)`);
    }
    if (!labels && (e.type === 'label' || e.from || e.name)) say(n, 'label syntax without the labels option (D11)');
    const parent = stack[d - 1];
    if (e.name && parent && parent.type === 'field' && parent.from === 'embedded') say(n, 'items of embedded fields have no name (D13)');
    if (!ranges && e.range) say(n, 'range without the ranges option (D9)');
    // Ranges are checked against Ord input only; JSON and CSV positions aren't checked here.
    if (e.range && test.kind === 'dump') checkRange(e, stack[d - 1], src, (msg) => say(n, msg));
  }
  return out;
}

function checkRange(e, parent, src, say) {
  const [l1, c1, l2, c2] = e.range;
  if (l1 > l2 || (l1 === l2 && c1 >= c2)) return say('range ends before it starts (D9)');
  const line = src[l1 - 1];
  if (!line || (l1 === l2 && c2 - 1 > line.length) || c1 - 1 > line.length) return say('range is outside the input (D9)');
  if (l1 !== l2) return; // blocks: not checked further
  const slice = line.slice(c1 - 1, c2 - 1).join('');
  const indent = indentOf(line.join('')).length;
  if (e.from && /^[ \t]|[ \t]$/.test(slice)) say(`range "${slice}" includes whitespace around the form (D10)`);
  if (['node', 'listnode', 'field'].includes(e.type) && !e.from) {
    if (c1 !== indent + 1 || c2 !== line.length + 1) say(`range should cover the line after the indent, @${l1}:${indent + 1}-${l1}:${line.length + 1} (D10)`);
  } else if (e.type === 'item' && e.text) {
    if (e.text.quoted) {
      if (slice.length < 2 || slice[0] !== slice[slice.length - 1] || !QUOTES.includes(slice[0])) say(`range "${slice}" is not the quoted text (D10)`);
    } else if (parent && parent.type === 'field' && parent.from && parent.key.value === '_state') {
      if (Array.from(slice).length !== 1) say(`range "${slice}" is not the state marker (D10)`);
    } else if (slice !== e.text.value) say(`range covers "${slice}", not the item "${e.text.value}" (D10)`);
  } else if (e.type === 'label' || e.type === 'empty') {
    say(`${e.type} lines have no range (D10)`);
  }
  if (e.type === 'item' && parent && parent.range && parent.range[0] === l1 && parent.range[2] === l2 && (c1 < parent.range[1] || c2 > parent.range[3]))
    say('range lies outside its parent\'s range');
}

function lintOther(test) {
  const out = [];
  const where = `test ${test.number} (line ${test.line})`;
  if (!test.expected.length) out.push(`${where}: empty expected output`);
  if (test.kind === 'to-json') {
    try { JSON.parse(test.expected); } catch (e) { out.push(`${where}: expected output isn't JSON: ${e.message}`); }
  }
  if (test.kind === 'from-json') {
    try { JSON.parse(test.input); } catch (e) { out.push(`${where}: input isn't JSON: ${e.message}`); }
  }
  return out;
}

// Deep equality for JSON values, with object members in any order (T7).
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
}

// ---------- run (T4, T5, T7) ----------

function exec(cmd, flags, input) {
  const r = spawnSync([cmd, ...flags].join(' '), { input, shell: true, maxBuffer: 1 << 26, timeout: 20000 });
  if (r.error) return { error: r.error.message };
  return { out: r.stdout, err: r.stderr.toString('utf8').trim() };
}

function firstDiff(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `  line ${i + 1}\n    expected ${JSON.stringify(a[i] ?? '(nothing)')}\n    actual   ${JSON.stringify(b[i] ?? '(nothing)')}`;
  }
  return '';
}

// Dump commands get --ranges and --labels; fmt gets --labels and, with it, --today (T4);
// graph gets --today (Semantics M70).
function flagsFor(t) {
  if (t.kind === 'fmt') return fmtFlags(t);
  if (t.kind === 'graph') return ['--today', `${t.today}T${TIME}`];
  const allowed = DUMP_KINDS.has(t.kind) ? ['ranges', 'labels'] : [];
  return t.options.filter((o) => allowed.includes(o)).map((o) => '--' + o);
}
const fmtFlags = (t) => (t.options.includes('labels') ? ['--labels', '--today', `${t.today}T${TIME}`] : []);

function run(tests, cmds, only) {
  let pass = 0, fail = 0, skip = 0;
  const fmt = cmds.fmt;
  const report = (ok, t, what, detail = '') => {
    const name = `test ${t.number} (line ${t.line}${t.rules.length ? ', ' + t.rules.join(' ') : ''})${what}`;
    if (ok) { pass++; console.log(`ok    ${name}`); }
    else { fail++; console.log(`FAIL  ${name}${detail ? '\n' + detail : ''}`); }
  };
  for (const t of tests) {
    if (only.length && !only.some((o) => t.rules.includes(o) || String(t.number) === o)) continue;
    const cmd = cmds[t.kind];
    if (!cmd) { skip++; console.log(`skip  test ${t.number} (line ${t.line}): no --${t.kind} command`); }
    else {
      const flags = flagsFor(t);
      const r = exec(cmd, flags, t.input);
      if (r.error) report(false, t, '', '  ' + r.error);
      else {
        const actual = r.out.toString('utf8');
        let ok;
        if (t.kind === 'to-json') {
          try { ok = jsonEqual(JSON.parse(actual), JSON.parse(t.expected)); } catch { ok = false; }
        } else ok = Buffer.compare(r.out, Buffer.from(t.expected, 'utf8')) === 0;
        report(ok, t, '', ok ? '' : firstDiff(t.expected, actual) + (r.err ? `\n  stderr: ${r.err}` : ''));
      }
    }
    if (fmt && ORD_INPUT.has(t.kind)) {
      const f = fmtFlags(t);
      const a = exec(fmt, f, t.input);
      const b = a.error ? a : exec(fmt, f, a.out);
      if (a.error || b.error) report(false, t, ' stable', '  ' + (a.error || b.error));
      else {
        const ok = Buffer.compare(a.out, b.out) === 0;
        report(ok, t, ' stable', ok ? '' : firstDiff(a.out.toString('utf8'), b.out.toString('utf8')));
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  return fail === 0;
}

// ---------- command line ----------

function main(argv) {
  const [cmd, spec, ...rest] = argv;
  if (!cmd || !spec || ['-h', '--help'].includes(cmd)) {
    const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const { tests, problems } = extract(readFileSync(spec, 'utf8'));
  if (cmd === 'list') {
    for (const t of tests) console.log(`${String(t.number).padStart(3)}  line ${String(t.line).padEnd(5)} ${t.kind.padEnd(9)} ${[...t.options.filter((o) => !KINDS.includes(o)), ...t.rules].join(' ')}`);
    problems.forEach((p) => console.error(p));
    return problems.length ? 1 : 0;
  }
  if (cmd === 'extract') {
    console.log(JSON.stringify(tests, null, 2));
    problems.forEach((p) => console.error(p));
    return problems.length ? 1 : 0;
  }
  if (cmd === 'coverage') {
    const text = readFileSync(spec, 'utf8');
    const rules = [...text.matchAll(/^\s*- \*\*([A-Z]\d+[a-z]?)\.\*\*/gm)].map((m) => m[1]);
    const named = new Set(tests.flatMap((t) => t.rules.map((r) => r.split('.')[0])));
    const byLetter = {};
    for (const r of rules) (byLetter[r[0]] ??= { all: 0, untested: [] }).all++, named.has(r) || byLetter[r[0]].untested.push(r);
    for (const [letter, { all, untested }] of Object.entries(byLetter))
      console.log(`${letter}: ${all - untested.length}/${all} named by a test${untested.length ? '; not: ' + untested.join(' ') : ''}`);
    return 0;
  }
  if (cmd === 'lint') {
    const all = [...problems, ...tests.flatMap((t) => [...(DUMP_KINDS.has(t.kind) ? lintDump(t) : []), ...lintOther(t)])];
    all.forEach((p) => console.log(p));
    console.log(`${tests.length} tests, ${all.length} problem${all.length === 1 ? '' : 's'}`);
    return all.length ? 1 : 0;
  }
  if (cmd === 'run') {
    const cmds = {};
    const only = [];
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i].replace(/^--/, '');
      if (k === 'only') only.push(rest[++i]);
      else if (k === 'dump' || KINDS.includes(k)) cmds[k] = rest[++i];
      else throw new Error(`unknown option ${rest[i]}`);
    }
    problems.forEach((p) => console.error(p));
    return run(tests, cmds, only) && !problems.length ? 0 : 1;
  }
  throw new Error(`unknown command ${cmd}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`ordtest: ${e.message}`);
  process.exitCode = 2;
}
