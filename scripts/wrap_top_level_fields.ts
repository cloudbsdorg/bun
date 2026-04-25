import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Simple script to wrap top-level field declarations like "@\"#raw\": u32," into a struct.
// It scans .zig files recursively from the project root.

function isTopLevelField(line: string): boolean {
  // Match pattern: optional whitespace, @"#raw": <type>, optional comma
  return /^\s*@\"#raw\"\s*:\s*[^,]+,?\s*$/.test(line);
}

function wrapFile(filePath: string): void {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  let changed = false;
  const newLines: string[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    if (isTopLevelField(line)) {
      buffer.push(line.trimEnd());
      changed = true;
    } else {
      if (buffer.length) {
        // wrap collected fields into a struct named TopLevelFields
        newLines.push('const TopLevelFields = struct {');
        for (const f of buffer) {
          // ensure field ends with comma
          const field = f.endsWith(',') ? f : f + ',';
          newLines.push('    ' + field);
        }
        newLines.push('};');
        buffer = [];
      }
      newLines.push(line);
    }
  }
  if (buffer.length) {
    newLines.push('const TopLevelFields = struct {');
    for (const f of buffer) {
      const field = f.endsWith(',') ? f : f + ',';
      newLines.push('    ' + field);
    }
    newLines.push('};');
  }
  if (changed) {
    writeFileSync(filePath, newLines.join('\n'), 'utf8');
    console.log(`Wrapped top-level fields in ${filePath}`);
  }
}

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat; try { stat = statSync(full); } catch (_) { continue; }
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full);
    } else if (full.endsWith('.zig')) {
      wrapFile(full);
    }
  }
}

walk(process.cwd());
