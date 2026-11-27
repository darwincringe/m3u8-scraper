// Decrypt vaplayer streamdata's encrypted `stream_urls` blob using the
// per-response WASM module advertised in `va.wasm_url` (same protocol as
// nextgencloudfabric's vadec.js: alloc → copy base64 → decrypt → read
// UTF-8 at ptr+12).
import fetch from "node-fetch";

const wasmCache = new Map(); // w → Promise<WebAssembly.Module>
const WASM_TTL_MS = 30 * 60 * 1000;

async function compileWasm(w, wasmUrl, fetchOpts) {
  const cached = wasmCache.get(w);
  if (cached && Date.now() - cached.at < WASM_TTL_MS) return cached.mod;
  const res = await fetch(wasmUrl, {
    ...fetchOpts,
    headers: {
      Accept: "*/*",
      ...(fetchOpts?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`vaplayer wasm ${res.status}`);
  const buf = await res.arrayBuffer();
  const mod = await WebAssembly.compile(buf);
  wasmCache.set(w, { at: Date.now(), mod: Promise.resolve(mod) });
  return mod;
}

export async function decryptVaplayerStreamUrls(json, fetchOpts = {}) {
  const va = json?.va || json?.vp;
  const encB64 = json?.data?.stream_urls;
  if (!va || typeof encB64 !== "string") return json;
  // Already a plaintext URL or newline-separated URL list — leave alone.
  if (/^https?:\/\//i.test(encB64.trim()) || /\nhttps?:\/\//i.test(encB64)) {
    json.data.stream_urls = encB64.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return json;
  }
  if (!va.wasm_url && !va.wasm) return json;

  const mod = va.wasm_url
    ? await compileWasm(va.w ?? va.wasm_url, va.wasm_url, fetchOpts)
    : await WebAssembly.compile(Buffer.from(va.wasm, "base64"));
  const inst = await WebAssembly.instantiate(mod, {});
  const ex = inst.exports;
  const enc = Buffer.from(encB64, "base64");
  const ptr = ex.alloc(enc.length);
  new Uint8Array(ex.memory.buffer, ptr, enc.length).set(enc);
  const outLen = ex.decrypt(ptr, enc.length);
  const txt = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr + 12, outLen));
  json.data.stream_urls = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return json;
}
