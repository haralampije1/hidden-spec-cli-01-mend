// mend: one patch tool for every AI edit format.
// Implements SPEC.md sections 1-10: command line, output and exit codes,
// safe paths, format detection, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits, tiered line matching and all-or-nothing writes.
// Node 22 standard library only: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`
//
// In a trial the grader runs `node /bot/main.ts` beside the trial env with
// MAKEFUN_ENV_URL set, and this file hands over to runner.ts exactly as the
// kit has it; otherwise it processes one patch from a file or stdin.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

// Patch lines: text split at \n, drop the empty piece after a final \n, and
// remove one trailing \r from each line (SPEC.md section 3).
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripOuter(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}
function stripAorB(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}
function leadingWs(s: string): string {
  let n = 0;
  while (n < s.length && (s[n] === ' ' || s[n] === '\t')) n += 1;
  return s.slice(0, n);
}
function detectBr(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}
function splitText(text: string): string[] {
  if (text === '') return [];
  const br = detectBr(text);
  const lines = text.split(br);
  if (text.endsWith(br)) lines.pop();
  return lines;
}
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

// Occurrences of pattern O in file lines, at a tier (0 exact; 1 sans trailing
// ws; 2 sans leading and trailing ws); overlaps allowed.
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  for (let i = 0; i <= lines.length - O.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      const a = lines[i + k];
      const b = O[k];
      let e: boolean;
      if (tier === 0) e = a === b;
      else if (tier === 1) e = stripTrailing(a) === stripTrailing(b);
      else e = stripOuter(a) === stripOuter(b);
      if (!e) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// tier 2 re-indent: replace the old block's leading whitespace (P) with the
// matched file line's leading whitespace (F). Only when P is non-empty.
function eqLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripOuter(a) === stripOuter(b);
}

function transformN(nL: string, pLead: string | null, fLead: string | null, strict: boolean): string {
  if (!strict && pLead !== null && pLead.length > 0 && !wsOnly(nL) && nL.startsWith(pLead)) return fLead === null ? nL.slice(pLead.length) : fLead + nL.slice(pLead.length);
  return nL;
}

// Sequential (subsequence) match of old side O in file lines, at a tier:
// positions strictly increasing; the returned match is the one whose first
// position is nearest to target (per SPEC.md section 6).
function sequentialMatch(fileLines: string[], O: string[], tier: number, target: number): number[] | null {
  const starts: number[] = [];
  for (let i = 0; i < fileLines.length; i += 1) if (eqLine(fileLines[i], O[0], tier)) starts.push(i);
  starts.sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
  for (const start of starts) {
    const pos: number[] = [start];
    let ok = true;
    for (let j = 1; j < O.length; j += 1) {
      let found = -1;
      for (let k = pos[pos.length - 1] + 1; k < fileLines.length; k += 1) {
        if (eqLine(fileLines[k], O[j], tier)) { found = k; break; }
      }
      if (found < 0) { ok = false; break; }
      pos.push(found);
    }
    if (ok) return pos;
  }
  return null;
}

// One change in the pending tree: new text (null: deleted) per path.
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// ---- sections 4-6: unified diffs ------------------------------------------

function diffGit(l: string): { old: string; new: string } | null {
  const m = l.match(/^diff --git (.*)$/);
  if (!m) return null;
  const rest = m[1];
  const aIdx = rest.indexOf(' a/');
  const bIdx = rest.lastIndexOf(' b/');
  if (aIdx < 0 || bIdx < 0 || bIdx <= aIdx) return null;
  return { old: rest.slice(aIdx + 3, bIdx), new: rest.slice(bIdx + 3) };
}

interface Hunk { A: number; O: string[]; N: string[]; Oraw: string[]; Nraw: string[]; noNewline: boolean }
interface Section { oldPath: string | null; newPath: string | null; create: boolean; del: boolean; move: boolean; hunks: Hunk[] }

function parseHunks(lines: string[], start: number): { hunks: Hunk[]; end: number } {
  const hunks: Hunk[] = [];
  let h = start;
  const n = lines.length;
  while (h < n) {
    const m = lines[h].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (!m) {
      if (lines[h].startsWith('@@')) throw new Exit2(`error: parse ${h + 1}`);
      break;
    }
    const A = +m[1];
    const body: string[] = [];
    let k = h + 1;
    while (k < n) {
      const l = lines[k];
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && lines[k + 1]?.startsWith('+++ ')) break;
      if (l.startsWith('@@')) break;
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) body.push(l);
      else break;
      k += 1;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const O: string[] = [];
    const N: string[] = [];
    const Oraw: string[] = [];
    const Nraw: string[] = [];
    let noNewline = false;
    for (const l of body) {
      if (l.startsWith('\\')) { noNewline = true; continue; }
      if (l.startsWith(' ')) { Oraw.push(l); Nraw.push(l); O.push(l.slice(1)); N.push(l.slice(1)); }
      else if (l.startsWith('-')) { Oraw.push(l); Nraw.push(''); O.push(l.slice(1)); N.push(''); }
      else if (l.startsWith('+')) { Oraw.push(''); Nraw.push(l); O.push(''); N.push(l.slice(1)); }
      else { Oraw.push(''); Nraw.push(''); O.push(''); N.push(''); }
    }
    hunks.push({ A, O, N, Oraw, Nraw, noNewline });
    h = k;
  }
  return { hunks, end: h };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    const sectionStart = l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
    if (!sectionStart) { i += 1; continue; }
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    let createFlag = false;
    let delFlag = false;
    if (l.startsWith('--- ')) {
      const tab = l.indexOf('\t');
      oldPath = stripAorB(stripOuter(l.slice(4, tab < 0 ? l.length : tab)));
    }
    let h = i + 1;
    let firstHunk = n;
    while (h < n) {
      const lh = lines[h];
      if (lh.startsWith('@@')) { firstHunk = h; break; }
      if (lh.startsWith('diff --git ')) {
        const g = diffGit(lh);
        if (g === null) throw new Exit2(`error: parse ${h + 1}`);
        gitOld = g.old; gitNew = g.new;
        firstHunk = h;
        break;
      }
      if (lh.startsWith('--- ') && !(lines[h + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${h + 1}`);
      if (lh.startsWith('--- ')) {
        const tab = lh.indexOf('\t');
        oldPath = stripAorB(stripOuter(lh.slice(4, tab < 0 ? lh.length : tab)));
      } else if (lh.startsWith('+++ ')) {
        const tab = lh.indexOf('\t');
        newPath = stripAorB(stripOuter(lh.slice(4, tab < 0 ? lh.length : tab)));
      } else if (lh.startsWith('rename from ')) {
        oldPath = stripOuter(lh.slice(12));
      } else if (lh.startsWith('rename to ')) {
        newPath = stripOuter(lh.slice(10));
      } else if (lh === 'new file mode' || lh.startsWith('new file mode ')) {
        createFlag = true;
      } else if (lh === 'deleted file mode' || lh.startsWith('deleted file mode ')) {
        delFlag = true;
      }
      h += 1;
    }
    if (oldPath === null && gitOld !== null) oldPath = stripAorB(gitOld);
    if (newPath === null && gitNew !== null) newPath = stripAorB(gitNew);
    const create = createFlag || oldPath === '/dev/null';
    const del = delFlag || newPath === '/dev/null';
    const move = oldPath !== null && newPath !== null && oldPath !== newPath && !create && !del;
    const { hunks, end } = parseHunks(lines, firstHunk);
    sections.push({ oldPath, newPath, create, del, move, hunks });
    i = end;
  }
  return sections;
}

function matchOldSide(fileLines: string[], oldSeq: string[], strict: boolean, target: number): number[] | null {
  const tiers = strict ? [0] : [0, 1, 2];
  // Contiguous match first.
  for (const tier of tiers) {
    const occ = occurrences(fileLines, oldSeq, tier);
    if (occ.length > 0) {
      let best = occ[0];
      let bestDist = Math.abs(best - target);
      for (const c of occ) {
        const dist = Math.abs(c - target);
        if (dist < bestDist) best = c, bestDist = dist;
      }
      const match: number[] = [];
      for (let k = 0; k < oldSeq.length; k += 1) match.push(best + k);
      return match;
    }
  }
  // Sequential match with gaps.
  for (const tier of tiers) {
    for (let p = 0; p < fileLines.length; p += 1) {
      if (!eqLine(fileLines[p], oldSeq[0], tier)) continue;
      const match: number[] = [p];
      let ok = true;
      for (let j = 1; j < oldSeq.length; j += 1) {
        let found = -1;
        for (let k = match[j - 1] + 1; k < fileLines.length; k += 1) {
          if (eqLine(fileLines[k], oldSeq[j], tier)) { found = k; break; }
        }
        if (found < 0) { ok = false; break; }
        match.push(found);
      }
      if (ok) return match;
    }
  }
  return null;
}

function applyUnifiedText(text: string | null, hunks: Hunk[], strict: boolean, path: string): string {
  const before = text === null ? '' : text;
  const br = detectBr(before);
  const hadFinal = before !== '' && before.endsWith(br);
  const all = before === '' ? [] : before.split(br);
  // The trailing empty piece after a final break is not a line (SPEC.md section 3).
  const work = hadFinal ? all.slice(0, -1) : all;
  let fileLines = work;
  let forcedFinal: boolean | null = null;
  let drift = 0;
  for (const h of hunks) {
    // Old side: context and '- ' lines, in body order (blank context lines included).
    const oldSeq: string[] = [];
    for (const ro of h.Oraw)
      if (ro.startsWith(' ')) oldSeq.push(ro.slice(1));
      else if (ro.startsWith('-')) oldSeq.push(ro.slice(1));
      else if (ro === '') oldSeq.push('');
    // New side: context and '+ ' lines, in body order.
    const newSeq: string[] = [];
    for (const rn of h.Nraw)
      if (rn.startsWith(' ')) newSeq.push(rn.slice(1));
      else if (rn.startsWith('+')) newSeq.push(rn.slice(1));
    if (oldSeq.length === 0) {
      // Empty old side: insert after the first A + d lines.
      const pos = Math.min(Math.max(h.A + drift, 0), fileLines.length);
      if (pos === fileLines.length) forcedFinal = h.noNewline ? false : true;
      const ins: string[] = [];
      for (const rn of h.Nraw) if (rn.startsWith('+')) ins.push(transformN(rn.slice(1), null, null, strict));
      fileLines.splice(pos, 0, ...ins);
      drift += newSeq.length - oldSeq.length;
      continue;
    }
    const matchArr = matchOldSide(fileLines, oldSeq, strict, h.A - 1 + drift);
    if (matchArr === null) throw new Fail('no-match', path);
    const wasEnd = matchArr[matchArr.length - 1] === fileLines.length - 1;
    if (wasEnd) forcedFinal = h.noNewline ? false : true;
    if (wasEnd) forcedFinal = h.noNewline ? false : true;
    const pLead = leadingWs(oldSeq[0]);
    const fLead = leadingWs(fileLines[matchArr[0]]);
    // Emit: context lines from the file at matched positions, new lines from the patch,
    // deleted lines dropped; everything between matched positions is carried over.
    const rep: string[] = [];
    let cursor = 0;
    let qi = 0;
    for (const ro of h.Oraw) {
      if (ro.startsWith(' ')) {
        const m = matchArr[qi];
        qi += 1;
        rep.push(...fileLines.slice(cursor, m));
        rep.push(fileLines[m]);
        cursor = m + 1;
      } else if (ro.startsWith('-')) {
        const m = matchArr[qi];
        qi += 1;
        cursor = m + 1;
      } else if (ro === '') {
        // Blank context line: matches a blank file line at the matched position.
        const m = matchArr[qi];
        qi += 1;
        rep.push(...fileLines.slice(cursor, m));
        rep.push(fileLines[m]);
        cursor = m + 1;
      }
    }
    for (const rn of h.Nraw) {
      if (rn.startsWith(' ')) rep.push(transformN(rn.slice(1), pLead, fLead, strict));
      else if (rn.startsWith('+')) rep.push(transformN(rn.slice(1), pLead, fLead, strict));
    }
    rep.push(...fileLines.slice(cursor));
    fileLines = rep;
    drift += newSeq.length - oldSeq.length;
  }
  const finalBreak = forcedFinal !== null ? forcedFinal : hadFinal;
  return fileLines.length === 0 ? '' : fileLines.join(br) + (finalBreak ? br : '');
}

function unifiedSectionEdit(sec: Section, strict: boolean): (tree: Tree) => void {
  const pathSec = sec.move ? sec.newPath! : (sec.newPath ?? sec.oldPath!);
  return (tree) => {
    if (sec.oldPath !== '/dev/null' && !safe(sec.oldPath!)) throw new Fail('unsafe', sec.oldPath!);
    if (sec.newPath !== null && sec.newPath !== '/dev/null' && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    if (sec.create) {
      if (tree.get(pathSec!) !== null) throw new Fail('exists', pathSec!);
      let lines: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        for (const l of h.N) lines.push(l.startsWith('+') ? l.slice(1) : l);
        if (h.noNewline) noFinal = true;
      }
      tree.now.set(pathSec!, lines.length === 0 ? '' : lines.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (sec.del) {
      if (tree.get(pathSec!) === null) throw new Fail('missing', pathSec!);
      tree.now.set(pathSec!, null);
      return;
    }
    const p = pathSec!;
    if (sec.move) {
      const oldP = sec.oldPath!;
      const newP = sec.newPath!;
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      moves.push({ old: oldP, new: newP });
      tree.now.set(oldP, null);
      tree.now.set(newP, applyUnifiedText(before, sec.hunks, strict, oldP));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedText(before, sec.hunks, strict, p));
  };
}

// ---- section 7: SEARCH/REPLACE blocks -------------------------------------

function searchReplaceBlocks(text: string, lines: string[], strict: boolean): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  let i = 0;
  const n = lines.length;
  let currentPath: string | null = null;
  let blockStart = 0;
  while (i < n) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    let path: string | null = null;
    for (let j = i - 1; j >= blockStart; j -= 1) {
      const l = lines[j];
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = stripOuter(l);
      break;
    }
    if (path === null || path === '') {
      if (currentPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = currentPath;
    } else {
      path = stripAorB(stripOuter(path));
    }
    currentPath = path;
    let eqLine = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (lines[j].trimEnd() === '=======') { eqLine = j; break; }
    }
    if (eqLine < 0) throw new Exit2(`error: parse ${i + 1}`);
    let close = -1;
    for (let j = eqLine + 1; j < n; j += 1) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') { close = j; break; }
    }
    if (close < 0) throw new Exit2(`error: parse ${i + 1}`);
    blockStart = close + 1;
    const oldLines = lines.slice(i + 1, eqLine);
    const newLines = lines.slice(eqLine + 1, close);
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const out: string[] = [];
        for (const l of newLines) out.push(l.startsWith('+') ? l.slice(1) : l);
        tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const work = splitText(before);
      let occ: number[];
      for (const tier of strict ? [0] : [0, 1, 2]) {
        occ = occurrences(work, oldLines, tier);
        if (occ.length > 0) break;
      }
      if (occ.length === 0) throw new Fail('no-match', path);
      if (occ.length > 1) throw new Fail('ambiguous', path);
      const pos = occ[0];
      const outN: string[] = [];
      const pLead = leadingWs(oldLines[0]);
      const fLead = leadingWs(work[pos]);
      for (const nl of newLines) outN.push(transformN(nl, pLead, fLead, strict));
      const br = detectBr(before);
      const hadFinal = before !== '' && before.endsWith(br);
      const res = [...work.slice(0, pos), ...outN, ...work.slice(pos + oldLines.length)];
      tree.now.set(path, res.length === 0 ? '' : res.join(br) + (hadFinal ? br : ''));
    });
    i = close + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- section 8: V4A patches -----------------------------------------------

function v4aSections(text: string, lines: string[], strict: boolean): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const lastNonBlank = lines.findLastIndex((l) => !blank(l));
  if (lines[lastNonBlank]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  let i = first + 1;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (blank(l)) { i += 1; continue; }
    if (l === '*** Begin Patch') { i += 1; continue; }
    if (l === '*** End Patch') break;
    if (l.startsWith('@@')) { i += 1; continue; } // chunk headers are consumed inside Update File sections
    if (l.startsWith('*** Add File: ')) {
      const path = stripOuter(l.slice(14));
      const body: string[] = [];
      let j = i + 1;
      while (j < n && !lines[j].startsWith('*** ')) body.push(lines[j++]);
      if (j < n && lines[j] !== '*** End Patch' && !lines[j].startsWith('*** Add File:') && !lines[j].startsWith('*** Delete File:') && !lines[j].startsWith('*** Update File:')) throw new Exit2(`error: parse ${j + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const out: string[] = [];
        for (const s of body) out.push(s.startsWith('+') ? s.slice(1) : s);
        tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = stripOuter(l.slice(17));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = stripOuter(l.slice(17));
      let moveTo: string | null = null;
      let j = i + 1;
      if (j < n && lines[j].startsWith('*** Move to: ')) {
        moveTo = stripOuter(lines[j].slice(13));
        j += 1;
      }
      const chunks: Array<{ anchor: string | null; O: string[]; N: string[]; Oraw: string[]; Nraw: string[]; endOfFile: boolean }> = [];
      let hadMoveOrChunk = moveTo !== null;
      while (j < n) {
        const c = lines[j];
        if (c === '*** End of File') { chunks.push({ anchor: null, O: [], N: [], Oraw: [], Nraw: [], endOfFile: true }); j += 1; break; }
        if (c.startsWith('*** ')) break;
        let anchor: string | null = null;
        if (c.startsWith('@@')) { anchor = stripOuter(c.slice(2)); j += 1; }
        const O: string[] = [];
        const N: string[] = [];
        const Oraw: string[] = [];
        const Nraw: string[] = [];
        while (j < n) {
          const d = lines[j];
          if (d === '*** End of File') { chunks.push({ anchor: null, O: [], N: [], Oraw: [], Nraw: [], endOfFile: true }); j += 1; break; }
          if (d.startsWith('*** ')) break;
          if (d === '' || d.startsWith(' ') || d.startsWith('-') || d.startsWith('+')) {
            if (d.startsWith(' ')) { Oraw.push(d); Nraw.push(d); O.push(d.slice(1)); N.push(d.slice(1)); }
            else if (d.startsWith('-')) { Oraw.push(d); Nraw.push(''); O.push(d.slice(1)); N.push(''); }
            else if (d.startsWith('+')) { Oraw.push(''); Nraw.push(d); O.push(''); N.push(d.slice(1)); }
            else { Oraw.push(''); Nraw.push(''); O.push(''); N.push(''); }
            j += 1;
          } else break;
        }
        chunks.push({ anchor, O, N, Oraw, Nraw, endOfFile: false });
        hadMoveOrChunk = true;
      }
      if (!hadMoveOrChunk) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const br = detectBr(before);
        const hadFinal = before !== '' && before.endsWith(br);
        const all = splitText(before);
        const work = hadFinal ? all.slice(0, -1) : all;
        const oldSeq: string[] = [];
        for (const ro of ch.Oraw)
          if (ro.startsWith(' ')) oldSeq.push(ro.slice(1));
          else if (ro.startsWith('-')) oldSeq.push(ro.slice(1));
          else if (ro === '') oldSeq.push('');
        const p = bestOldSideMatch(work, oldSeq, strict, 0);
        if (p === null) throw new Fail('no-match', path);
        const matchArr: number[] = [];
        for (let k = 0; k < oldSeq.length; k += 1) matchArr.push(p + k);
        const wasEnd = matchArr[matchArr.length - 1] === work.length - 1;
        if (wasEnd) forcedFinal = h.noNewline ? false : true;
        const pLead = leadingWs(oldSeq[0]);
        const fLead = leadingWs(work[p]);
        const out: string[] = [];
        let cursor = 0;
        let qi = 0;
        for (const ro of ch.Oraw) {
          if (ro.startsWith(' ')) {
            const m = matchArr[qi];
            qi += 1;
            if (m >= cursor) {
              out.push(...work.slice(cursor, m));
              out.push(work[m]);
              cursor = m + 1;
            }
          } else if (ro.startsWith('-')) {
            const m = matchArr[qi];
            qi += 1;
            cursor = m + 1;
          } else if (ro.startsWith('+')) {
            out.push(transformN(rn.slice(1), pLead, fLead, strict));
          } else if (ro === '') {
            const m = matchArr[qi];
            qi += 1;
            if (m >= cursor) {
              out.push(...work.slice(cursor, m));
              out.push(work[m]);
              cursor = m + 1;
            }
          }
        }
        for (const rn of ch.Nraw) {
          if (rn.startsWith(' ')) out.push(transformN(rn.slice(1), pLead, fLead, strict));
          else if (rn.startsWith('+')) out.push(transformN(rn.slice(1), pLead, fLead, strict));
        }
        out.push(...work.slice(cursor));
        const finalText = out.length === 0 ? '' : out.join(br) + (hadFinal ? br : '');
        if (moveTo !== null) tree.now.set(path, null);
        tree.now.set(moveTo !== null ? moveTo : path, finalText);
      });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- section 9: JSON edits ------------------------------------------------

function jsonEdit(v: unknown): ((tree: Tree) => void) | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str.replace(/\r\n/g, '\n');
    const newStr = ((o.new_str as string | undefined) ?? '').replace(/\r\n/g, '\n');
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const t = before.replace(/\r\n/g, '\n');
      let count = 0;
      for (let k = t.indexOf(oldStr); k >= 0; k = t.indexOf(oldStr, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(oldStr);
      let out = t.slice(0, at) + newStr + t.slice(at + oldStr.length);
      if (crlf) out = out.replaceAll('\n', '\r\n');
      tree.now.set(p, out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const br = detectBr(before);
      const hadFinal = before !== '' && before.endsWith(br);
      const work = splitText(before);
      if (line < 0 || line > work.length) throw new Fail('no-match', p);
      const res = [...work.slice(0, line), ...add, ...work.slice(line)];
      tree.now.set(p, res.length === 0 ? '' : res.join(br) + (hadFinal ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): ((tree: Tree) => void)[] {
  const edits: ((tree: Tree) => void)[] = [];
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const parseLine = first + 1;
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${parseLine}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${parseLine}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${parseLine}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: ((tree: Tree) => void) | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 4: format detection ------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- sections 1-2, 10: command line, apply, output ------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  const seen = new Set<string>();
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (seen.has('--format')) return { code: 2, out: ['error: usage'] };
        const value = a.slice(9);
        if (!FORMATS.includes(value)) return { code: 2, out: ['error: usage'] };
        seen.add('--format'); format = value;
      } else if (a === '--check') {
        if (seen.has('--check')) return { code: 2, out: ['error: usage'] };
        seen.add('--check'); check = true;
      } else if (a === '--strict') {
        if (seen.has('--strict')) return { code: 2, out: ['error: usage'] };
        seen.add('--strict'); strict = true;
      } else return { code: 2, out: ['error: usage'] };
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: ((tree: Tree) => void)[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') {
      const sections = parseUnified(lines);
      edits = sections.map((s) => unifiedSectionEdit(s, strict));
    } else if (kind === 'search-replace') edits = searchReplaceBlocks(text, lines, strict);
    else edits = v4aSections(text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<{ old: string; new: string }> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    const out: string[] = [];
    for (const f of fails) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${fails.length} of ${edits.length} edits`);
    return { code: 1, out };
  }
  const moveOld = new Set(moves.map((m) => m.old));
  const newToOld = new Map(moves.map((m) => [m.new, m.old]));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && moveOld.has(p)) continue; // emitted as R below, sorted by the new path
    const line = newToOld.has(p) ? `R ${newToOld.get(p)} -> ${p}` : now === null ? `D ${p}` : was === null ? `A ${p}` : `M ${p}`;
    rows.push({ key: p, line });
  }
  const outLines: string[] = [];
  for (const row of rows) outLines.push(row.line);
  if (check) {
    // nothing written
  } else {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        const d = dirOf(p);
        if (d !== '' && d !== '.') mkdirSync(d, { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const r = run(process.argv.slice(2));
writeSync(1, r.out.map((l) => `${l}\n`).join(''));
process.exitCode = r.code;

// Trial hand-over: in a trial the grader runs `node /bot/main.ts` beside the
// env with MAKEFUN_ENV_URL set, and this file hands over to runner.ts, as the
// kit has it.
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
}
