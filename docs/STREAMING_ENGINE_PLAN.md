# GraceTracks — Option B: Streaming AudioWorklet Engine (Implementation Plan)

> Status: **Plan / pre-implementation.** Supersedes the `MediaElementAudioSourceNode`
> phase-lock engine *for capable browsers* once shipped; the phase-lock engine stays
> as the fallback. Driven by the on-device spike findings below.

---

## 1. Goal & non-goals

**Goal:** DAW-grade playback of N stems — sample-locked (zero drift, forever),
sample-accurate seek/loop, instant transport, per-stem gain/mute/solo — on the full
song library (including 6+ minute songs, 8+ stems) across iOS/Android/desktop Safari
& Chrome, **without** holding whole songs of PCM in memory.

**Non-goals:** time-stretch / pitch-shift, recording, effects beyond gain, changing the
upload pipeline or R2 layout, or touching GraceChords.

---

## 2. Why — the spike that settled it

Measured on-device (iPhone, iOS 18.7 / Safari 26.5) with `great_is_the_lord`
(8 stems, **6.24 min**, 48 kHz stereo) via `public/stem-spike.html`:

| Finding | Value | Consequence |
|---|---|---|
| Decode time, all 8 stems | **1.75 s** | Decode is fast — never the bottleneck |
| Single-clock sample-locked playback | "sounded a good bit better" | **One shared clock = tight sync on iOS** ✅ |
| Int16 PCM, sustained | **548 MB** | Too heavy to keep resident on 3–4 GB devices |
| Float32 PCM, held (worst case) | **1.10 GB → tab force-refresh (OOM) on flagship** | Hard ceiling, even on the best device |

**Key insight:** an `AudioBuffer` is always Float32 in RAM and `AudioBufferSourceNode`
needs the *entire* buffer resident to play it. Playing this song that way = ~1.1 GB of
live buffers = the crash we observed. So **full-decode (Option A) is non-viable for
real-length songs.** The fix is to keep one clock but *stream* PCM into it — decode a
few seconds ahead, never hold the whole song.

---

## 3. Target architecture

```
                main thread / Web Worker                 audio render thread
  ┌──────────────────────────────────────────┐        ┌────────────────────────┐
  R2 .m4a ──Range/fetch──▶ Demux (mp4box.js) ─▶ EncodedAudioChunk
                                   │                    │
                                   ▼                    │
                          WebCodecs AudioDecoder ──AudioData(PCM)──▶ ring buffer (per stem)
                                   │                    │                 │
                       (decode ~3–4 s ahead of         │                 ▼
                        the playhead, then pause)       │      AudioWorkletProcessor "stem-mixer"
                                                        │        • pulls 128 frames/stem/quantum
                                                        │        • applies gain/mute/solo
                                                        │        • sums → stereo out
                                                        │        • ONE clock → sample-locked
                                                        └────────────────┬───────┘
                                                                         ▼
                                                          masterGain ▶ AnalyserNode(s) ▶ destination
```

One `AudioContext`, one `AudioWorkletNode` (the mixer). Every stem is consumed by the
same `process()` calls at the same sample index — drift is impossible by construction.

### Components / modules

| Module | Responsibility |
|---|---|
| `src/audio/stream/demux.js` | Wrap mp4box.js: open an `.m4a`, expose AAC `AudioSpecificConfig` + an async iterator of `EncodedAudioChunk`s with sample timestamps. |
| `src/audio/stream/decoder.js` | Per-stem WebCodecs `AudioDecoder`; converts encoded chunks → `AudioData` → planar Float32; honors decode-ahead backpressure; supports flush+reposition for seek. |
| `src/audio/stream/ringbuffer.js` | Per-stem PCM queue. Lock-free SAB variant later; **v1 uses `postMessage`-transfer of Float32 chunks** to the worklet (no cross-origin isolation needed). |
| `src/audio/stream/mixer-processor.js` | The `AudioWorkletProcessor`. Mixes stems with per-stem gain; reports playhead + underrun count to the main thread. Bundled as a separate worklet module. |
| `src/audio/stream/engine.js` | Orchestrator implementing the **same public API as today's `engine.js`** (see §9), so `mixer.js`/`transport.js` need ~no changes. |
| `src/audio/engineFactory.js` | Capability detection → returns the streaming engine or the phase-lock fallback (§8). |

---

## 4. Memory model

Resident PCM = `lookahead_seconds × sampleRate × channels × 4 B × stems`.

For 4 s lookahead, 48 kHz, stereo, 8 stems: `4 × 48000 × 2 × 4 × 8 ≈ 12.3 MB` — **flat,
independent of song length.** Versus 1.1 GB for full decode. Compressed source is never
fully held either (Range/stream the `.m4a`, decode-ahead window only).

Tunable: smaller lookahead = less RAM, larger = more underrun headroom on slow CPUs. Start
at 4 s; expose for tuning during M0/M1.

---

## 5. Decode pipeline

1. **Demux** the `.m4a` with **mp4box.js** (battle-tested; bundle via npm, don't hand-roll
   an MP4 parser). Extract the AAC `AudioSpecificConfig` (for `AudioDecoder.configure({codec:'mp4a.40.2', description})`)
   and the sample table; emit `EncodedAudioChunk`s.
2. **Decode** with WebCodecs `AudioDecoder`. Maintain a decode-ahead window: decode until
   the ring buffer holds `lookahead` seconds, then stop dequeuing encoded chunks until the
   playhead advances (backpressure). `AudioData.copyTo` into planar Float32, push to ring.
3. **Feed** the worklet: transfer Float32 chunks via `port.postMessage(buf, [transfer])`.
4. **Release** consumed PCM (drop chunks behind the playhead).

**Fetching:** stems are fetched with Range requests so we never download more than we’re
about to decode; the existing `CacheFirst` SW cache still serves repeat plays fast.

---

## 6. Worklet mixer

- `process(_, outputs)`: for each of the 128 frames, for each stem pull one sample from its
  queue (or silence + `underruns++` if starved — **never stall the mix**, so all stems stay
  sample-locked), multiply by the stem's smoothed gain, sum into stereo out.
- **Gain/mute/solo:** per-stem gain values updated via control messages; smoothed over a few
  ms inside the processor to avoid zipper noise. Solo = others' gain → 0.
- **Metering:** the processor can emit per-stem peak/RMS alongside the playhead message, or we
  keep `AnalyserNode`s on a post-mix split — TBD in M2 (cheap either way).
- **Playhead:** processor posts `framesRendered` every ~100 ms; transport position =
  `framesRendered / sampleRate`. This is the single source of truth (a real audio clock).

---

## 7. Transport

| Action | Mechanism |
|---|---|
| **Play** | Resume `AudioContext` (user gesture), ensure decode-ahead has primed ring buffers, then the worklet starts consuming. All stems advance from the same frame index → identical start. |
| **Pause** | Stop the worklet consuming (gate flag) + pause decoders; keep buffers. |
| **Seek** | Compute target sample. Flush ring buffers + reset each decoder, re-demux from the nearest AAC sync sample at/just before target (AAC-LC frames are independently decodable; prime ~1 frame), refill to lookahead, then resume. Brief, bounded refill; pre-buffer to hide it. Sample-accurate landing. |
| **Scrub** | Same as today's UX: pause-on-drag, seek-on-release. Optionally add audible scrub later. |
| **Loop** | Worklet wraps the playhead at loop end → loop start; decoders reposition. Sample-accurate, gapless. |
| **Count-in** | Unchanged metronome; it schedules on the same `AudioContext` clock, then we start the worklet at the scheduled frame. |

---

## 8. Browser support & fallback

| Capability | Where | Path |
|---|---|---|
| `AudioWorklet` | iOS 14.5+, all modern | required for streaming engine |
| WebCodecs `AudioDecoder` (AAC) | **Safari 26+/iOS 26+**, Chrome/Edge/Android | primary decode path |
| — older Safari/iOS (< 26) | no WebCodecs audio | **Fallback A:** stream the `.wav` via Range (no decoder, universal, bigger bytes) **or Fallback B:** today's phase-lock `MediaElement` engine |

`engineFactory.js` picks at runtime:
1. WebCodecs AAC supported → **streaming engine (AAC)**.
2. Else `.wav` present + AudioWorklet → **streaming engine (WAV/PCM)** (also serves as the
   universal path; no codec needed — parse header, slice PCM).
3. Else → **phase-lock `MediaElement` engine** (today's code, kept).

This guarantees correctness everywhere and DAW-grade sync wherever the streaming path is
available — which, per the spike, includes current iOS Safari.

---

## 9. Public API compatibility (so the UI doesn't change)

The streaming engine implements the **exact surface** `mixer.js` / `transport.js` already use:

```
loadStem(name, url[, res]) → Promise<name|null>
play(offsetSeconds=0[, atContextTime])   pause()   stop()   seekTo(seconds)
get playing / duration / currentTime      set loop
setMasterVolume(v)  setFader(name,v)  toggleMute(name)  toggleSolo(name)
getLoadedChannels()  getAnalyser(name)  getChannelState(name)
set onPositionUpdate(fn)  set onEnded(fn)   resumeIfSuspended()   dispose()
```

`renderMixer` only changes its one construction line (`new AudioEngine()` →
`createEngine()` from the factory). Everything downstream is untouched. This keeps the
refactor contained and reversible.

---

## 10. On-device validation plan (built into `stem-spike.html`)

Milestone 0 must pass on the **oldest supported** iPhone/iPad before we build the full
engine. The spike page gains a **Streaming test** section that measures and exports:

| Check | How the spike tests it | Acceptance |
|---|---|---|
| WebCodecs AAC availability | `AudioDecoder.isConfigSupported({codec:'mp4a.40.2', …})` | reported true on Safari 26+/Chrome |
| **Worklet mixer is glitch-free** | Play decoded stems through the `stem-mixer` worklet fed from Int16 at a set lookahead; processor counts **underruns** | underruns ≈ 0 at 1–4 s lookahead; sounds tight |
| **Playback memory is bounded** | Report peak in-flight ring PCM (MB) during worklet playback | ≪ Int16 total (target ~tens of MB) |
| Sample-lock | Single playhead drives all stems by design; verify identical per-stem consumed counts | exact |
| Seek | Worklet seek test (jump + return); confirm audible + correct position | lands correctly, no drift after |

Export JSON gains a `streaming` block (support flags, lookahead, underruns, quanta,
peak ring MB, seek result) appended to the existing `⧉ Copy results JSON`.

> Note: the spike’s worklet test reuses the already-decoded Int16 (so it adds no extra
> memory) and feeds it to the worklet in small chunks — proving the **playback** half
> (worklet sample-lock + bounded playback RAM). The remaining **decode-streaming** half
> (WebCodecs → ring) is exercised by the capability probe here and wired for real in M1.

---

## 11. Milestones

- **M0 — Validate (this commit):** spike page streaming test + WebCodecs probe; pass on
  oldest device. *Gate before further work.*
- **M1 — Decode-streaming PoC:** real WebCodecs + mp4box demux → ring buffer for 2–3 stems;
  prove bounded *total* memory (decode-ahead, not whole file) and decode-keeps-ahead on device.
- **M2 — Mixer feature parity:** gain curve (reuse `faderToLinear`), mute/solo, master, metering.
- **M3 — Transport:** play/pause/seek/loop/count-in/position; scrub UX parity.
- **M4 — Fallback + factory:** WAV-PCM streaming path + phase-lock fallback; `engineFactory`
  capability routing; cross-device matrix test.
- **M5 — Cutover:** swap `renderMixer` to the factory; keep phase-lock for unsupported; remove
  spike page; update tests + docs.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| WebCodecs audio absent on older iOS | Factory fallback to WAV-PCM streaming or phase-lock engine |
| Worklet underruns on slow CPUs | Tunable lookahead; decode in a Web Worker off the main thread; pre-buffer before play |
| Seek refill latency (re-prime AAC) | Pre-buffer a small margin each side; demux sample table cached so reposition is O(1) lookup |
| mp4box.js bundle size / quirks | It's the standard tool; tree-shake; isolate behind `demux.js` |
| SAB/cross-origin isolation friction with R2 | **Avoid SAB in v1** — use `postMessage` transfer; revisit SAB only if profiling demands it (would need CORP headers on R2) |
| Memory regressions creep back | Keep the spike page's bounded-memory assertion as a manual gate each milestone |

---

## 13. Docs / constraints to update at cutover

- `CLAUDE.md` constraint #2 ("never `decodeAudioData`; use `MediaElementAudioSourceNode`")
  → rewrite to: "stream-decode in bounded chunks (WebCodecs → AudioWorklet); never hold a
  whole song of PCM; phase-lock `MediaElement` engine is the fallback." The OOM rationale
  stays — the streaming engine honors it (~12 MB resident, not 1.1 GB).
- `CODEX_CONTEXT.md` audio section + architecture diagram.
- `AGENT_LOG.md` entry per milestone.
