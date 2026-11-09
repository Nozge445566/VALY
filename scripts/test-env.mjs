// Preloaded by `npm test` (node --import). Makes the tests independent of the machine they run on.
// Node 22 has a global `navigator` whose language follows the OS / LANG (sv-SE on a Swedish machine),
// which made tests that expect "no browser = English" fail only on Swedish computers.
Object.defineProperty(globalThis, "navigator", {
  value: { language: "en-US", languages: ["en-US"] },
  configurable: true,
  writable: true,
});
