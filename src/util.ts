import os from 'node:os';
import path from 'node:path';

/**
 * Root of the agent-workflows state directory.
 * SPEC § Storage: `~/.agent-workflows`, overridable with env `AW_HOME`.
 * Read from the environment on every call so tests can change it at runtime.
 */
export function awHome(): string {
  const override = process.env.AW_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.agent-workflows');
}

/**
 * Filesystem-safe slug for a single path segment (T06 step 2; reused by T09/T10/T16).
 * Lowercases, collapses every run of non-alphanumerics into `-`, trims leading/trailing `-`.
 * Because `/`, `.` and spaces all collapse to `-`, the result can never traverse directories.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
