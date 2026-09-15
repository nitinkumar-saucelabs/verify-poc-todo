const fs = require('node:fs');
const path = require('node:path');

const QUARANTINE_FILE = path.join(__dirname, 'quarantine.json');

/** Escape a literal test title for use inside a RegExp. */
function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Read quarantine.json and return the entries, or [] if absent or malformed. */
function readQuarantineEntries() {
  try {
    const raw = fs.readFileSync(QUARANTINE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.quarantined) ? parsed.quarantined : [];
  } catch {
    return [];
  }
}

/**
 * Build the `grepInvert` value for playwright.config.js.
 *
 * Returns undefined when nothing is quarantined — an empty regex would match
 * every title and silently skip the whole suite.
 */
function readQuarantineGrep() {
  const titles = readQuarantineEntries()
    .map((entry) => entry.test)
    .filter((title) => typeof title === 'string' && title.length > 0);

  if (titles.length === 0) return undefined;
  return new RegExp(titles.map(escapeForRegExp).join('|'));
}

module.exports = { readQuarantineEntries, readQuarantineGrep, QUARANTINE_FILE };
