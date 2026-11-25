"use client";

import { analyticsRunId, trackConversion } from "@/lib/conversion-analytics";
import { canEncodeVideo } from "mediabunny";
import { useCallback, useEffect, useRef, useState } from "react";
import SettingHelp from "@/components/SettingHelp";
import { type Check } from "@/lib/oqm/patch";
import {
  DEFAULT_RECIPE,
  sameRecipe,
  OqmError,
  convert,
  type ConvertResult,
  type EncodeOptions,
  type Recipe,
  type Stage,
} from "@/lib/oqm/pipeline";

type Run = {
  analyticsId: string;
  id: number;
  file: File;
  recipe: Recipe;
  status: "queued" | "running" | "done" | "error";
  stage?: Stage;
  result?: ConvertResult;
  url?: string;
  error?: string;
};

const STORE = "oqm-recipe-v1";

function loadRecipe(): Recipe {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
    // Settings saved for a retired method start over, so no one is left on an option they can't see.
    if (saved?.method === "silent-tail" && saved.encode) {
      return { ...DEFAULT_RECIPE, encode: { ...DEFAULT_RECIPE.encode, ...saved.encode } };
    }
  } catch {}
  return DEFAULT_RECIPE;
}

function saveRecipe(recipe: Recipe) {
  try {
    localStorage.setItem(STORE, JSON.stringify(recipe));
  } catch {}
}

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

let nextId = 1;

/** The only website method, so analytics records just whether its settings were changed. */
const presetFor = (recipe: Recipe) => (sameRecipe(DEFAULT_RECIPE, recipe) ? "silent-tail" : "custom");

export default function Converter({
  file = null,
  onClose,
  onCounted,
  standalone = false,
  embedded = false,
  onBusyChange,
}: {
  file?: File | null;
  onClose?: () => void;
  onCounted?: (count: number | null) => void;
  standalone?: boolean;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [recipe, setRecipeState] = useState<Recipe>(DEFAULT_RECIPE);
  const [selectedFile, setSelectedFile] = useState<File | null>(file);
  const [runs, setRuns] = useState<Run[]>([]);
  const [hevc, setHevc] = useState<boolean | null>(null);
  const [dropping, setDropping] = useState(false);
  const runsRef = useRef<Run[]>([]);
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const counted = useRef(new Set<number>());
  const closed = useRef(false);
  const pickRef = useRef<HTMLInputElement>(null);

  const setRecipe = (next: Recipe) => {
    setRecipeState(next);
    saveRecipe(next);
  };
  const setEncode = (patch: Partial<EncodeOptions>) => setRecipe({ ...recipe, encode: { ...recipe.encode, ...patch } });

  const update = useCallback((id: number, change: Partial<Run>) => {
    runsRef.current = runsRef.current.map((r) => (r.id === id ? { ...r, ...change } : r));
    setRuns(runsRef.current);
  }, []);

  const count = useCallback(
    (run: Run) => {
      if (counted.current.has(run.id)) return;
      counted.current.add(run.id);
      fetch("/api/conversion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "single" }) })
        .then((r) => r.json())
        .then((d) => typeof d.count === "number" && onCounted?.(d.count))
        .catch(() => {});
    },
    [onCounted],
  );

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      onBusyChange?.(true);
      for (;;) {
        const run = runsRef.current.find((r) => r.status === "queued");
        if (!run || closed.current) break;
        const controller = new AbortController();
        abort.current = controller;
        update(run.id, { status: "running", stage: { label: "Starting", progress: null } });
        const startedAt = performance.now();
        const analyticsPreset = presetFor(run.recipe);
        trackConversion(run, "started", analyticsPreset);
        try {
          const result = await convert(run.file, run.recipe, (stage) => update(run.id, { stage }), controller.signal);
          if (closed.current || controller.signal.aborted) throw new OqmError("Stopped.");
          trackConversion({ ...run, result }, result.checks.every(c => c.ok || c.warn) ? "succeeded" : "check_failed", analyticsPreset, performance.now() - startedAt);
          update(run.id, { status: "done", result, url: URL.createObjectURL(result.blob) });
          if (result.checks.every((check) => check.ok || check.warn)) count(run);
        } catch (error) {
          trackConversion(run, controller.signal.aborted ? "cancelled" : "failed", analyticsPreset, performance.now() - startedAt, error);
          const message = controller.signal.aborted
            ? "Stopped."
            : error instanceof OqmError
              ? error.message
              : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
          update(run.id, { status: "error", error: message });
          if (!(error instanceof OqmError) && !controller.signal.aborted) console.error(error);
        }
      }
    } finally {
      busy.current = false;
      abort.current = null;
      onBusyChange?.(false);
    }
  }, [count, update, onBusyChange]);

  const queue = useCallback(
    (f: File, recipe: Recipe) => {
      if (closed.current) return;
      const fresh: Run = { analyticsId: analyticsRunId(), id: nextId++, file: f, recipe, status: "queued" };
      runsRef.current = [fresh, ...runsRef.current];
      setRuns(runsRef.current);
      void pump();
    },
    [pump],
  );

  // Selecting a file only stages it. Patching starts from an explicit action.
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setRuns(runsRef.current);
      const saved = loadRecipe();
      setRecipeState(saved);
      setSelectedFile(file);
    });
    return () => { active = false; };
  }, [file]);

  useEffect(() => {
    canEncodeVideo("hevc", { width: 1920, height: 1080 }).then(setHevc).catch(() => setHevc(false));
  }, []);

  // Closing stops any work in progress and drops what's still waiting.
  const close = useCallback(() => {
    if (!onClose) return;
    closed.current = true;
    runsRef.current = runsRef.current.map((r) => (r.status === "queued" ? { ...r, status: "error", error: "Stopped." } : r));
    abort.current?.abort();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, onClose]);

  // Next can keep a hidden route mounted. Release its files and run history together.
  useEffect(
    () => {
      closed.current = false;
      const countedRuns = counted.current;
      return () => {
        closed.current = true;
        abort.current?.abort();
        for (const r of runsRef.current) if (r.url) URL.revokeObjectURL(r.url);
        runsRef.current = [];
        countedRuns.clear();
      };
    },
    [],
  );

  const current = runs.find((r) => r.status === "running");
  const files = Array.from(new Set(runs.map((r) => r.file)));
  const activeFile = selectedFile;
  const latestSelectionRun = runs.find(r => r.file === activeFile);
  const selectionWasPatched = latestSelectionRun?.status === "done" && sameRecipe(latestSelectionRun.recipe, recipe);
  const e = recipe.encode;

  const onPick = (f: File | undefined) => {
    if (f) setSelectedFile(f);
  };

  return (
    <div className={standalone ? "converter-workspace" : "modal-back"} onMouseDown={(ev) => ev.target === ev.currentTarget && close()}>
      <div
        className={`studio${standalone ? " studio-page" : ""}${embedded ? " studio-embedded" : ""}${dropping ? " studio-drop" : ""}`}
        role={standalone ? "region" : "dialog"}
        aria-modal={standalone ? undefined : true}
        aria-label="Patch your video"
        onDragOver={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          setDropping(false);
          onPick(ev.dataTransfer.files[0]);
        }}
      >
        {onClose && (
          <button type="button" className="modal-x" onClick={close} aria-label="Close">
            ×
          </button>
        )}

        <section className="studio-main">
          <h2>Your video</h2>
          <div className="patch-start-row">
          <button type="button" className={activeFile ? "file-select has-file" : "file-select"} title={activeFile?.name} onClick={() => pickRef.current?.click()}>
            <svg className="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={activeFile ? "M5 2h9l5 5v15H5z M14 2v6h5 M9 12l5 3-5 3z" : "M2 4h20v16H2z M5 4v16m14-16v16M2 9h3m-3 6h3m14-6h3m-3 6h3 M9 12h6m-3-3v6"} />
            </svg>
            <span className="file-copy">
              <b>{activeFile ? activeFile.name : "Choose a video"}</b>
              <span>{activeFile ? `${formatSize(activeFile.size)} · Change video` : "or drop a file here · MP4, MOV & more"}</span>
            </span>
          </button>

          </div>
          <input
            ref={pickRef}
            type="file"
            accept="video/mp4,video/quicktime,video/*"
            hidden
            onChange={(ev) => {
              onPick(ev.target.files?.[0]);
              ev.target.value = "";
            }}
          />

        </section>

        <section className="studio-side">
          <h2>Output settings</h2>
          <p className="fine preset-description">Method: <b>Silent-tail (default)</b></p>
          <div className="basic-settings adv">
            <fieldset>
              <legend className="sr-only">Basic output settings</legend>
              <div className="setting-check">
                <label className="row">
                  <input type="checkbox" checked={e.reencode} onChange={(ev) => setEncode({ reencode: ev.target.checked })} />
                  Re-encode before patching
                </label>
                <SettingHelp label="Re-encode before patching">Rebuild video and audio using the settings below. Turn this off to keep the original streams; the file must already be an MP4 with AAC-LC stereo audio.</SettingHelp>
              </div>
              {!e.reencode && <p className="fine">The patch uses your existing video and audio streams. Output encoding settings are inactive.</p>}
              <div className={`grid basic-grid${e.reencode ? "" : " off"}`}>
                <div className="setting-field">
                  <span className="setting-title"><label htmlFor="setting-size">Resolution</label><SettingHelp label="Resolution">Keep the original dimensions or limit the shorter edge to the selected resolution.</SettingHelp></span>
                  <select id="setting-size" disabled={!e.reencode} value={e.size} onChange={(ev) => setEncode({ size: ev.target.value as EncodeOptions["size"] })}>
                    <option value="original">Keep original</option>
                    <option value="short-2160">Max 4K (2160p)</option>
                    <option value="short-1440">Max 1440p</option>
                    <option value="short-1080">Max 1080p</option>
                    <option value="short-720">Max 720p</option>
                  </select>
                </div>
                <div className="setting-field">
                  <span className="setting-title"><label htmlFor="setting-fps">Frame rate</label><SettingHelp label="Frame rate">Up to 60 fps preserves lower source frame rates and caps higher ones. Fixed frame rates can duplicate or drop frames; they do not interpolate motion.</SettingHelp></span>
                  <select id="setting-fps" disabled={!e.reencode} value={e.fps ?? ""} onChange={(ev) => setEncode({ fps: ev.target.value === "source-max-60" ? "source-max-60" : ev.target.value ? Number(ev.target.value) : null })}>
                    <option value="">Keep original</option>
                    <option value="source-max-60">Up to 60 fps (source)</option>
                    <option value="24">24 fps</option>
                    <option value="30">30 fps</option>
                    <option value="60">60 fps</option>
                  </select>
                </div>
                <div className="setting-field basic-audio">
                  <span className="setting-title"><label htmlFor="setting-audio">Audio</label><SettingHelp label="Audio">AAC audio bitrate. Higher values use more space to preserve more audio detail.</SettingHelp></span>
                  <select id="setting-audio" disabled={!e.reencode} value={e.audioKbps} onChange={(ev) => setEncode({ audioKbps: Number(ev.target.value) })}>
                    <option value={128}>AAC 128 kbps</option>
                    <option value={192}>AAC 192 kbps</option>
                    <option value={256}>AAC 256 kbps</option>
                    <option value={320}>AAC 320 kbps</option>
                  </select>
                </div>
              </div>
            </fieldset>
          </div>

          <details className="settings-more">
            <summary>Advanced settings</summary>
          <div className="settings-groups">
          <details className="settings-section settings-video">
            <summary>
              <span>Encoding</span>
              <span className="section-meta">{e.reencode ? `${e.codec === "avc" ? "H.264" : "HEVC"} · ${e.fps === "source-max-60" ? "Up to 60 fps" : e.fps ? `${e.fps} fps` : "Original fps"}` : "No re-encode"}</span>
            </summary>
            <div className="settings-body adv">
              <fieldset>
                <legend className="sr-only">Advanced encoding options</legend>
                <div className={`grid${e.reencode ? "" : " off"}`}>
                  <div className="setting-field">
                    <span className="setting-title"><label htmlFor="setting-codec">Codec</label><SettingHelp label="Codec">Choose H.264 for broad compatibility or HEVC when your browser supports it.</SettingHelp></span>
                    <select id="setting-codec" value={e.codec} onChange={(ev) => setEncode({ codec: ev.target.value as EncodeOptions["codec"] })}>
                      <option value="avc">H.264</option>
                      <option value="hevc" disabled={hevc === false}>
                        H.265 / HEVC{hevc === false ? " (not in this browser)" : ""}
                      </option>
                    </select>
                  </div>
                  <div className="setting-field">
                    <span className="setting-title"><label htmlFor="setting-rate">Rate control</label><SettingHelp label="Rate control">Choose a quality target, fixed bitrate, or an automatic quality level.</SettingHelp></span>
                    <select id="setting-rate" value={e.rate} onChange={(ev) => setEncode({ rate: ev.target.value as EncodeOptions["rate"] })}>
                      <option value="quantizer">Quality (like CRF)</option>
                      <option value="bitrate">Fixed bitrate</option>
                      <option value="very-high">Very high (auto)</option>
                      <option value="high">High (auto)</option>
                    </select>
                  </div>
                  {e.rate === "quantizer" && (
                    <div className="setting-field">
                    <span className="setting-title"><label htmlFor="setting-quality">Quality {e.quantizer}</label><SettingHelp label="Quality">Lower values preserve more detail and usually produce larger files.</SettingHelp></span>
                    <input id="setting-quality" type="range" min={10} max={30} value={e.quantizer} onChange={(ev) => setEncode({ quantizer: Number(ev.target.value) })} />
                    </div>
                  )}
                  {e.rate === "bitrate" && (
                    <div className="setting-field">
                    <span className="setting-title"><label htmlFor="setting-bitrate">Bitrate (Mbps)</label><SettingHelp label="Bitrate (Mbps)">Target video bitrate in megabits per second. Higher values usually increase detail and file size.</SettingHelp></span>
                    <input id="setting-bitrate"
                        type="number"
                        min={1}
                        max={80}
                        step={0.5}
                        value={e.mbps}
                        onChange={(ev) => setEncode({ mbps: Math.max(1, Number(ev.target.value) || 1) })}
                      />
                    </div>
                  )}
                  <div className="setting-field">
                    <span className="setting-title"><label htmlFor="setting-keyframes">Keyframes</label><SettingHelp label="Keyframes">Choose how often a full video frame is stored. A long gap may reduce compatibility or make seeking slower.</SettingHelp></span>
                    <select id="setting-keyframes" value={e.keyframeSec} onChange={(ev) => setEncode({ keyframeSec: Number(ev.target.value) })}>
                      <option value={1}>Every 1 s</option>
                      <option value={2}>Every 2 s</option>
                      <option value={5}>Every 5 s</option>
                      <option value={0}>Only the first frame (long gap)</option>
                    </select>
                  </div>
                  <div className="setting-field">
                    <span className="setting-title"><label htmlFor="setting-encoder">Encoder</label><SettingHelp label="Encoder">Let the browser choose, or prefer hardware or software encoding. The browser cannot select an H.264 profile, so Constrained Baseline is unavailable.</SettingHelp></span>
                    <select id="setting-encoder" value={e.hardware} onChange={(ev) => setEncode({ hardware: ev.target.value as EncodeOptions["hardware"] })}>
                      <option value="no-preference">Browser decides</option>
                      <option value="prefer-hardware">Prefer hardware (faster)</option>
                      <option value="prefer-software">Prefer software</option>
                    </select>
                  </div>
                </div>
              </fieldset>
            </div>
          </details>

          <details className="settings-section settings-tools">
            <summary><span>Tools &amp; help</span><span className="section-meta">How it works</span></summary>
            <div className="settings-body studio-tools">
              <p className="fine">Silent-tail appends about 0.35 seconds of AAC silence and adds an audio track. Patching leaves
                the encoded video unchanged. TikTok quality and retention can vary.</p>
              <details className="tip">
                <summary>How to tell if it worked</summary>
                <p>
                  Local checks cover file integrity only. Start with the same 1080p60 SDR source. Check your post
                  after processing, then at 24 hours, 72 hours and seven days on desktop and a second phone/account.
                  Check every accessible rendition and its frame rate. A quality label alone does not prove unchanged video.
                  Test 4K next; keep 120 fps and HDR in separate rounds.
                </p>
              </details>
              <p className="fine">Local checks do not verify TikTok upload quality or retention.</p>
            </div>
          </details>

          </div>

          </details>

          <div className="settings-footer">
            <p className="fine">Settings saved for your next patch.</p>
            <button type="button" className="again" onClick={() => setRecipe(DEFAULT_RECIPE)}>
              Reset to default
            </button>
          </div>
        </section>
        <div className="patch-controls">
          <p>{current ? "Patching your video. Keep this page open." : selectionWasPatched ? "Download your MP4 below." : activeFile ? "Ready to patch." : "Choose a video to start patching."}</p>
          {current ? <button type="button" className="btn btn-secondary" onClick={() => abort.current?.abort()}>Stop patching</button> : (
            <button
              type="button"
              className={selectionWasPatched ? "btn btn-secondary" : "sun-action"}
              disabled={!activeFile}
              onClick={() => activeFile && queue(activeFile, recipe)}
            >
              {selectionWasPatched ? "Start again" : "Start patching"}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
            </button>
          )}
        </div>
          {runs.length > 0 && (
            <ul className="runs">
              {runs.map((run) => (
                <RunCard key={run.id} run={run} showFile={files.length > 1} />
              ))}
            </ul>
          )}

      </div>
    </div>
  );
}

function RunCard({ run, showFile }: { run: Run; showFile: boolean }) {
  const outName = `${stem(run.file.name)}_oqm-silent-tail.mp4`;
  const hard = run.result?.checks.filter((c) => !c.ok && !c.warn) ?? [];
  return (
    <li className={`run run-${run.error === "Stopped." ? "stopped" : run.status}`}>
      <div className="run-head">
        <b>Silent-tail</b>
        {showFile && <span className="run-file">{run.file.name}</span>}
        {run.status === "queued" && <span className="run-tag">waiting</span>}
      </div>

      {run.status === "running" && (
        <div className="run-progress">
          <span>{run.stage?.label ?? "Working"}</span>
          <div className="bar" role="progressbar" aria-label={run.stage?.label ?? "Patching"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.stage?.progress != null ? Math.round(run.stage.progress * 100) : undefined}>
            <div className={run.stage?.progress == null ? "bar-fill bar-busy" : "bar-fill"} style={run.stage?.progress != null ? { width: `${run.stage.progress * 100}%` } : undefined} />
          </div>
        </div>
      )}

      {run.status === "error" && run.error && <p role="status" className={run.error === "Stopped." ? "run-meta" : "modal-error"}>{run.error === "Stopped." ? "Patching stopped. You can start again." : [run.stage?.label, run.error].filter(Boolean).join(" — ")}</p>}

      {run.status === "done" && run.result && run.url && (
        <>
          <p className="output-name">{outName}</p>
          <div className="run-meta">
            {run.result.info.width} × {run.result.info.height} · {Math.round(run.result.info.fps * 100) / 100} fps · {run.result.info.mbps.toFixed(1)} Mbps ·{" "}
            {formatSize(run.result.blob.size)}
            {run.result.info.reencoded ? "" : " · not re-encoded"}
          </div>
          <div className="run-row">
            <a className="sun-action" href={run.url} download={outName} onClick={() => trackConversion(run, "downloaded", presetFor(run.recipe))}>
              Download MP4
            </a>
            <span className={hard.length ? "run-bad" : "run-ok"}>{hard.length ? `${hard.length} check(s) failed` : <><span aria-hidden="true">✓ </span>Local checks passed</>}</span>
          </div>
          <details>
            <summary>Details</summary>
            <ul className="checks">
              {run.result.checks.map((c: Check) => (
                <li key={c.name} className={c.ok ? "ok" : "bad"}>
                  <span>{c.ok ? "✓" : c.warn ? "!" : "✕"}</span>
                  <span>
                    {c.name} <i>{c.detail}</i>
                  </span>
                </li>
              ))}
            </ul>
            <p className="fine">
              Applied: {run.result.applied.join(", ")}
              {run.result.skipped.length ? ` · Skipped: ${run.result.skipped.join(", ")}` : ""}
            </p>
            {run.result.notes.map((n) => (
              <p className="fine" key={n}>
                {n}
              </p>
            ))}
          </details>
        </>
      )}
    </li>
  );
}
