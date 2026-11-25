import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Use the real Mediabunny MP4 reader and stream-copy path, with no browser encoder.
const dir = await mkdtemp(fileURLToPath(new URL("../.oqm-pipeline-test-", import.meta.url)));
after(() => rm(dir, { recursive: true, force: true }));
const analytics = await readFile(new URL("../src/lib/conversion-analytics.ts", import.meta.url), "utf8");
await writeFile(path.join(dir, "conversion-analytics.mjs"), ts.transpileModule(analytics, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
for (const name of ["patch", "silentTail", "pipeline"]) {
  const source = (await readFile(new URL(`../src/lib/oqm/${name}.ts`, import.meta.url), "utf8"))
    .replaceAll('"./patch"', '"./patch.mjs"').replaceAll('"./silentTail"', '"./silentTail.mjs"');
  await writeFile(path.join(dir, `${name}.mjs`), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
const { sameRecipe, prepareInputDecoders, convert, targetSize, targetFrameRate, DEFAULT_RECIPE } = await import(pathToFileURL(path.join(dir, "pipeline.mjs")));
test("the patcher offers only silent-tail and keeps the basic options", async () => {
  for (const name of ["SettingHelp", "EditFigures"]) {
    const component = await readFile(new URL(`../src/components/${name}.tsx`, import.meta.url), "utf8");
    await writeFile(path.join(dir, `${name}.mjs`), ts.transpileModule(component, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: name + ".tsx",
    }).outputText);
  }
  const source = (await readFile(new URL("../src/components/Converter.tsx", import.meta.url), "utf8"))
    .replaceAll('"@/lib/oqm/patch"', '"./patch.mjs"').replaceAll('"@/lib/oqm/pipeline"', '"./pipeline.mjs"')
    .replaceAll('"@/components/EditFigures"', '"./EditFigures.mjs"')
    .replaceAll('"@/components/SettingHelp"', '"./SettingHelp.mjs"').replaceAll('"@/lib/conversion-analytics"', '"./conversion-analytics.mjs"');
  await writeFile(path.join(dir, "Converter.mjs"), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: "Converter.tsx",
  }).outputText);
  const { default: Converter } = await import(pathToFileURL(path.join(dir, "Converter.mjs")));
  const html = renderToStaticMarkup(createElement(Converter, { standalone: true }));
  assert.match(html, /role="region"/);
  for (const id of ["size", "fps", "audio"]) assert.match(html, new RegExp(`<select id="setting-${id}"`), "basic option kept: " + id);
  assert.match(html, /Re-encode before patching/);
  assert.match(html, /Silent-tail/);
  assert.doesNotMatch(html, /<label>Preset|Original OQM|Container patches|Decoy|Make local comparison/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start patching<svg/);
  const selected = renderToStaticMarkup(createElement(Converter, {
    standalone: true, file: new File(["test"], "selected-test.mp4", { type: "video/mp4" }),
  }));
  assert.match(selected, /selected-test\.mp4/);
  assert.match(selected, /Change video/);
  assert.match(selected, /<button[^>]*>Start patching<svg/);
  assert.doesNotMatch(selected.match(/<button[^>]*>Start patching<svg/)?.[0] ?? "", /disabled/);
  assert.doesNotMatch(selected, /Start again|run-running|Working…|studio-upload/);
});
test("resolution limits downscale in both orientations without upscaling", () => {
  assert.deepEqual(targetSize({ width: 3840, height: 2160 }, "short-1080"), { width: 1920, height: 1080 });
  assert.deepEqual(targetSize({ width: 2160, height: 3840 }, "short-1080"), { width: 1080, height: 1920 });
  assert.deepEqual(targetSize({ width: 7680, height: 4320 }, "short-2160"), { width: 3840, height: 2160 });
  assert.deepEqual(targetSize({ width: 4320, height: 7680 }, "short-2160"), { width: 2160, height: 3840 });
  assert.deepEqual(targetSize({ width: 1920, height: 1080 }, "short-2160"), {});
  assert.deepEqual(targetSize({ width: 1280, height: 720 }, "short-1080"), {});
  for (const fps of [24, 29.97, 30, 59.94, 60]) assert.equal(targetFrameRate(fps, "source-max-60"), undefined);
  for (const fps of [90, 120]) assert.equal(targetFrameRate(fps, "source-max-60"), 60);
  assert.equal(targetFrameRate(120, null), undefined);
  assert.equal(targetFrameRate(24, 60), 60);
});
test("silent-tail patches a compatible MP4 without re-encoding", async () => {
  const source = path.join(dir, "source.mp4");
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=60:d=0.5",
    "-f", "lavfi", "-i", "sine=sample_rate=48000:d=0.5", "-ac", "2", "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", source]);
  assert.equal(made.status, 0, made.stderr?.toString());
  const result = await convert(new File([await readFile(source)], "source.mp4"),
    { ...DEFAULT_RECIPE, encode: { ...DEFAULT_RECIPE.encode, reencode: false } });
  assert.deepEqual(result.checks.filter(c => !c.ok && !c.warn), []);
  assert.equal(result.info.width, 320);
  assert.equal(result.info.height, 568);
  assert.ok(Math.abs(result.info.fps - 60) < 0.01, String(result.info.fps));
  assert.equal(result.info.reencoded, false);
  assert.equal(DEFAULT_RECIPE.method, "silent-tail");
  assert.equal(DEFAULT_RECIPE.encode.reencode, true);
  assert.equal(DEFAULT_RECIPE.encode.codec, "avc");
  assert.deepEqual(DEFAULT_RECIPE.patch.enabled, []);
});

test("a video without audio is refused before encoding with a clear message", async () => {
  const source = path.join(dir, "mute.mp4");
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  assert.equal(made.status, 0, made.stderr?.toString());
  await assert.rejects(convert(new File([await readFile(source)], "mute.mp4"), DEFAULT_RECIPE), /no audio track/);
});

test("sources this machine can't re-encode keep their original video and still get patched", async () => {
  // Node has no video codecs, like a machine without HEVC support.
  for (const [codec, tag, ext, audio] of [["libx265", "hvc1", "mp4", "aac"], ["libx265", "hev1", "mp4", "aac"], ["libx265", "hvc1", "mov", "aac"], ["libx264", "avc1", "mp4", "aac"], ["libx264", "avc1", "mov", "aac"]]) {
    const source = path.join(dir, `keep-${tag}.${ext}`);
    const made = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=60:d=1", "-f", "lavfi", "-i", "sine=sample_rate=48000:d=1",
      "-ac", "2", "-c:v", codec, ...(codec === "libx265" ? ["-x265-params", "log-level=error"] : []), "-tag:v", tag, "-pix_fmt", "yuv420p", "-c:a", audio, "-shortest", source]);
    assert.equal(made.status, 0, made.stderr?.toString());
    const file = new File([await readFile(source)], `clip.${ext}`);
    const name = `${tag} ${ext}`;
    const codecs = [];
    const result = await convert(file, { ...DEFAULT_RECIPE, encode: { ...DEFAULT_RECIPE.encode, size: "short-720", fps: 30 } }, () => {}, undefined, c => codecs.push(c));
    assert.deepEqual(codecs, [codec === "libx265" ? "hevc" : "avc"], name);
    assert.match(result.fallback, /kept your original video.*Your frame rate setting wasn't applied/, name);
    assert.equal(result.info.reencoded, false);
    assert.deepEqual(result.checks.filter(c => !c.ok && !c.warn), [], name);
    const out = path.join(dir, `out-${tag}-${ext}.mp4`);
    await writeFile(out, Buffer.from(await result.blob.arrayBuffer()));
    const hash = f => spawnSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0:v:0", "-f", "md5", "-"]).stdout.toString();
    assert.ok(hash(source).startsWith("MD5="));
    assert.equal(hash(out), hash(source), `${name}: every decoded frame is identical`);
    const plain = await convert(file, { ...DEFAULT_RECIPE, encode: { ...DEFAULT_RECIPE.encode, reencode: false } });
    assert.equal(plain.fallback, undefined);
    assert.deepEqual(plain.checks.filter(c => !c.ok && !c.warn), [], `${name} without re-encode`);
  }
});

test("a rotated phone clip stays upright when its original video is kept", async () => {
  const flat = path.join(dir, "flat.mp4"), source = path.join(dir, "rotated.mov"), out = path.join(dir, "rotated-out.mp4");
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1", "-f", "lavfi", "-i", "sine=sample_rate=48000:d=1", "-ac", "2",
    "-c:v", "libx265", "-x265-params", "log-level=error", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", flat]).status, 0);
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-display_rotation", "90", "-i", flat, "-c", "copy", source]).status, 0);
  const result = await convert(new File([await readFile(source)], "rotated.mov"), DEFAULT_RECIPE);
  assert.ok(result.fallback);
  assert.deepEqual([result.info.width, result.info.height], [180, 320]);
  await writeFile(out, Buffer.from(await result.blob.arrayBuffer()));
  const rotation = f => spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=rotation", "-of", "csv=p=0", f]).stdout.toString().trim();
  assert.equal(rotation(out), rotation(source));
});

// Decode real ProRes + PCM data with the production registration path, not a mocked browser codec.
test("ProRes MOV loads its decoder on demand and preserves decodable PCM audio", async () => {
  const { Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioSampleSink } = await import("mediabunny");
  const source = path.join(dir, "prores.mov");
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=0.1",
    "-f", "lavfi", "-i", "sine=sample_rate=48000:d=0.1", "-ac", "2", "-c:v", "prores_ks", "-profile:v", "1",
    "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le", "-shortest", source]);
  assert.equal(made.status, 0, made.stderr?.toString());
  const input = new Input({ source: new BlobSource(new Blob([await readFile(source)])), formats: ALL_FORMATS });
  try {
    const stages = [];
    await prepareInputDecoders(input, stage => stages.push(stage.label));
    assert.ok(stages.includes("Loading ProRes support"));
    const video = await input.getPrimaryVideoTrack();
    assert.equal(video.codec, "prores");
    assert.equal(await video.canDecode(), true);
    let frames = 0;
    for await (const sample of new VideoSampleSink(video).samples()) {
      assert.equal(sample.displayWidth, 128);
      assert.equal(sample.displayHeight, 72);
      sample.close();
      frames++;
    }
    assert.equal(frames, 3);
    const audio = await input.getPrimaryAudioTrack();
    assert.equal(await audio.canDecode(), true);
    const sample = await new AudioSampleSink(audio).getSample(0);
    assert.ok(sample);
    assert.equal(sample.numberOfChannels, 2);
    sample.close();
    await assert.rejects(prepareInputDecoders(input, () => {}, AbortSignal.abort()), /Stopped/);
  } finally { input.dispose(); }
});

test("saved silent-tail defaults match the default regardless of property order and unused settings", () => {
  // This is the exact object order produced by loadRecipe after localStorage is read.
  const saved = JSON.parse(JSON.stringify(DEFAULT_RECIPE));
  const restored = { encode: { ...DEFAULT_RECIPE.encode, ...saved.encode }, patch: saved.patch, method: saved.method };
  assert.notEqual(JSON.stringify(restored), JSON.stringify(DEFAULT_RECIPE));
  assert.equal(sameRecipe(DEFAULT_RECIPE, restored), true);
  // Earlier silent-tail settings retained legacy patch toggles; those are never applied by silent-tail.
  const stale = { ...restored, patch: { ...restored.patch, enabled: ["faststart", "decoy-audio"] },
    encode: { ...restored.encode, mbps: 60 } }; // Bitrate is inactive in quantizer mode.
  assert.equal(sameRecipe(DEFAULT_RECIPE, stale), true);
  assert.equal(sameRecipe(DEFAULT_RECIPE, { ...restored, encode: { ...restored.encode, fps: 30 } }), false);
  assert.equal(sameRecipe(DEFAULT_RECIPE, { ...restored, encode: { ...restored.encode, quantizer: 23 } }), false);
  assert.equal(sameRecipe(DEFAULT_RECIPE, { ...restored, encode: { ...restored.encode, reencode: false } }), false);
  assert.equal(sameRecipe(DEFAULT_RECIPE, { ...restored, method: "legacy" }), false);
  const original = { ...restored, method: "legacy", patch: { ...restored.patch, enabled: ["faststart", "decoy-audio"] } };
  assert.equal(sameRecipe(original, { patch: { ...original.patch, enabled: [...original.patch.enabled].reverse() }, encode: { ...original.encode }, method: "legacy" }), true);
});
