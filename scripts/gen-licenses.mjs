#!/usr/bin/env node
// Generate the list of third-party components PortalGems ships, and their
// license texts.
//
//   node scripts/gen-licenses.mjs
//
// Writes two files, both committed:
//
//   packages/core/src/licenses.json   name, version and license of every
//                                     component, per platform - what the
//                                     About screen in each app lists
//   THIRD-PARTY-LICENSES.txt          the same lists, followed by the license
//                                     texts themselves
//
// The lists come from what is actually installed and locked, not from a
// hand-kept table, so they cannot quietly go stale: npm packages are walked
// from each app's `dependencies` through node_modules, and Rust crates from
// `cargo metadata`, following normal dependencies only. Both are a little
// over-inclusive on purpose - a crate that is only compiled on another
// platform is still listed - because naming a component that is not in a
// particular build costs nothing, and leaving one out is the mistake.
//
// What neither tool knows about is listed in EXTRA below: the runtimes the
// apps are built on, the Android libraries pulled in by Gradle, and the
// code vendored into the Symbian client.
//
// Run it after changing a dependency and before a release. It needs
// `npm install` done in packages/app-desktop and packages/app-mobile, and
// cargo able to resolve native/wormhole-core and native/wormhole-node.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(root, ...parts);

/** Components no package manager reports. `text` is where the license can be read. */
const EXTRA = {
  desktop: [
    ['Electron', '', 'MIT', 'https://github.com/electron/electron/blob/main/LICENSE'],
    ['Chromium', '', 'BSD-3-Clause and others', 'https://chromium.googlesource.com/chromium/src/+/main/LICENSE'],
    ['Node.js', '', 'MIT and others', 'https://github.com/nodejs/node/blob/main/LICENSE'],
  ],
  android: [
    ['Hermes', '', 'MIT', 'https://github.com/facebook/hermes/blob/main/LICENSE'],
    ['AndroidX libraries', '', 'Apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0'],
    ['AndroidX Security Crypto', '', 'Apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0'],
    ['Tink', '', 'Apache-2.0', 'https://github.com/tink-crypto/tink-java/blob/main/LICENSE'],
    ['ZXing', '', 'Apache-2.0', 'https://github.com/zxing/zxing/blob/master/LICENSE'],
    ['ZXing Android Embedded', '', 'Apache-2.0', 'https://github.com/journeyapps/zxing-android-embedded/blob/master/COPYING'],
    ['Kotlin standard library', '', 'Apache-2.0', 'https://github.com/JetBrains/kotlin/blob/master/license/LICENSE.txt'],
  ],
  symbian: [
    ['TweetNaCl', '20140427', 'Public domain', 'https://tweetnacl.cr.yp.to/'],
    ['PGP word list', '', 'Public domain', 'https://en.wikipedia.org/wiki/PGP_word_list'],
  ],
};

// ---- npm ------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Where `name` resolves to from `fromDir`, the way Node looks it up. */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (dir === path.dirname(dir)) return null;
  }
}

function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (!l) return 'UNKNOWN';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x.type)).join(' OR ');
  return l.type ?? 'UNKNOWN';
}

/** Every package reachable from `appDir` through `dependencies`. */
function npmComponents(appDir) {
  const seen = new Map();
  const queue = [fs.realpathSync(appDir)];
  const first = queue[0];
  while (queue.length > 0) {
    const dir = queue.pop();
    const pkg = readJson(path.join(dir, 'package.json'));
    if (dir !== first) {
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) continue;
      seen.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), dir });
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const resolved = resolvePackage(dep, dir);
      // An optional or platform-specific dependency that is not installed
      // here is not in this build either.
      if (resolved) queue.push(resolved);
    }
  }
  // The project's own packages are not third-party.
  return [...seen.values()].filter(
    (c) => !['@portalgems/core', 'wormhole-rn'].includes(c.name)
  );
}

// ---- cargo ----------------------------------------------------------------

/** Every crate the root package of `crateDir` depends on at run time. */
function cargoComponents(crateDir) {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
      cwd: crateDir,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString()
  );
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const rootId = meta.resolve.root;
  const seen = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      // kind null is a normal dependency; "build" and "dev" never reach
      // the binary.
      if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg);
    }
  }
  seen.delete(rootId);
  return [...seen]
    .map((id) => packages.get(id))
    // The engine and the bindings are this project's own.
    .filter((p) => !['wormhole-core', 'wormhole-node'].includes(p.name))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? 'See license file' : 'UNKNOWN'),
      dir: path.dirname(p.manifest_path),
    }));
}

// ---- gathering ------------------------------------------------------------

function licenseTexts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^(licen[sc]e|copying|notice|unlicense)/i.test(n))
    .sort()
    .map((n) => path.join(dir, n))
    .filter((f) => fs.statSync(f).isFile())
    .map((f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim())
    .filter((t) => t.length > 0);
}

function byName(a, b) {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

function dedupe(components) {
  const seen = new Map();
  for (const c of components) seen.set(`${c.name}@${c.version}`, c);
  return [...seen.values()].sort(byName);
}

const extra = (platform) =>
  EXTRA[platform].map(([name, version, license, text]) => ({ name, version, license, text }));

const core = cargoComponents(at('native', 'wormhole-core'));
const platforms = {
  desktop: dedupe([
    ...extra('desktop'),
    ...npmComponents(at('packages', 'app-desktop')),
    ...core,
    ...cargoComponents(at('native', 'wormhole-node')),
  ]),
  android: dedupe([
    ...extra('android'),
    ...npmComponents(at('packages', 'app-mobile')),
    ...core,
  ]),
  symbian: dedupe(extra('symbian')),
};

// ---- licenses.json --------------------------------------------------------

const json = {};
for (const [platform, components] of Object.entries(platforms)) {
  json[platform] = components.map((c) => [c.name, c.version, c.license]);
}
fs.writeFileSync(
  at('packages', 'core', 'src', 'licenses.json'),
  JSON.stringify(json, null, 0).replace(/\],\[/g, '],\n[').replace(/:\[\[/g, ':[\n[') + '\n'
);

// ---- THIRD-PARTY-LICENSES.txt ---------------------------------------------

const TITLES = { desktop: 'Desktop (Linux, Windows, macOS)', android: 'Android', symbian: 'Symbian (PortalGems Mini)' };
const out = [];
out.push('PortalGems - third-party components');
out.push('====================================');
out.push('');
out.push('PortalGems itself is free software under the GNU General Public License,');
out.push('version 3 or later; see the LICENSE file. It is built on the components');
out.push('listed here, each under its own license. This file is generated by');
out.push('scripts/gen-licenses.mjs - do not edit it by hand.');
out.push('');
out.push('The engine at the heart of PortalGems is magic-wormhole.rs (EUPL-1.2),');
out.push('vendored with a small patch in native/magic-wormhole and combined with');
out.push('this program under the compatibility clause of the EUPL.');

for (const [platform, components] of Object.entries(platforms)) {
  out.push('', '', TITLES[platform], '-'.repeat(TITLES[platform].length), '');
  for (const c of components) {
    out.push(`${c.name}${c.version ? ' ' + c.version : ''} - ${c.license}${c.text ? ' - ' + c.text : ''}`);
  }
}

// One copy of each distinct text, with the components it came with. Many
// components carry byte-identical Apache-2.0 or MIT files.
const texts = new Map();
for (const components of Object.values(platforms)) {
  for (const c of components) {
    if (!c.dir) continue;
    for (const text of licenseTexts(c.dir)) {
      const key = createHash('sha256').update(text).digest('hex');
      if (!texts.has(key)) texts.set(key, { text, used: new Set() });
      texts.get(key).used.add(`${c.name} ${c.version}`);
    }
  }
}
out.push('', '', 'License texts', '-------------');
const ordered = [...texts.values()]
  .map((t) => ({ text: t.text, used: [...t.used].sort() }))
  .sort((a, b) => (a.used[0].toLowerCase() < b.used[0].toLowerCase() ? -1 : 1));
for (const { text, used } of ordered) {
  out.push('', '='.repeat(72), `Applies to: ${used.join(', ')}`, '='.repeat(72), '', text);
}
fs.writeFileSync(at('THIRD-PARTY-LICENSES.txt'), out.join('\n') + '\n');

const unknown = Object.values(platforms)
  .flat()
  .filter((c) => c.license === 'UNKNOWN')
  .map((c) => `${c.name} ${c.version}`);
for (const [platform, components] of Object.entries(platforms)) {
  console.log(`${platform}: ${components.length} components`);
}
console.log(`${texts.size} distinct license texts`);
if (unknown.length > 0) {
  console.log(`no license declared: ${[...new Set(unknown)].join(', ')}`);
}
