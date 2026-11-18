import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
const source=await readFile(new URL('../src/lib/conversion-analytics.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const api=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const visitor='4ed76815-3442-4fb7-b660-382afed057d0';
const assignment={experiment:'hero-headline-v1',visitor,variant:4};
test('ten arms and strict versioned attribution survive server validation',()=>{
  assert.equal(api.HEADLINE_VARIANTS.length,10);
  assert.deepEqual(api.HEADLINE_VARIANTS[0],['Stop TikTok from','compressing your video.']);
  assert.deepEqual(api.sanitizeHeadlineAssignment({...assignment,email:'secret'}),assignment);
  for(const variant of [-1,10,NaN,0.5,'1']) assert.equal(api.sanitizeHeadlineAssignment({...assignment,variant}),undefined);
  assert.equal(api.sanitizeHeadlineAssignment({...assignment,visitor:'bad'}),undefined);
  const event=api.sanitizeAnalytics({run_id:visitor,event:'succeeded',headline:assignment});
  assert.deepEqual(event.settings.headline,assignment);
  assert.deepEqual(api.sanitizeAnalytics(event).settings.headline,assignment);
});
test('sticky allocation, exposure retry and deduplication, attribution across pages, blocked storage',async()=>{
  const originalStorage=globalThis.localStorage,originalFetch=globalThis.fetch;
  const values=new Map();
  globalThis.localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  let calls=0,payload;
  try {
    const a=api.headlineAssignment();
    assert.ok(a.variant>=0 && a.variant<10);
    assert.deepEqual(api.headlineAssignment(),a);
    assert.equal(api.exposedHeadline(),undefined);
    globalThis.fetch=async()=>{calls++;return {ok:false};};
    await api.trackHeadlineExposure(a);
    assert.deepEqual(api.exposedHeadline(),a);
    globalThis.fetch=async()=>{calls++;return {ok:true};};
    await api.trackHeadlineExposure(a);
    await api.trackHeadlineExposure(a);
    assert.equal(calls,2);
    assert.deepEqual(api.exposedHeadline(),a);
    globalThis.fetch=async(_url,options)=>{payload=JSON.parse(options.body);return {ok:true};};
    api.trackConversion({analyticsId:visitor,file:new File(['x'],'private.mp4'),recipe:{}},'succeeded','silent-tail');
    assert.deepEqual(payload.settings.headline,a);
    assert.doesNotMatch(JSON.stringify(payload),/private/);
    globalThis.localStorage={getItem(){throw Error('blocked');}};
    assert.equal(api.headlineAssignment(),undefined);
    // The already visible assignment remains available even if storage later becomes blocked.
    assert.deepEqual(api.exposedHeadline(),a);
  } finally {globalThis.localStorage=originalStorage;globalThis.fetch=originalFetch;}
});

test('exposure API gates rollout on storage, rejects bad input, deduplicates and leaves counters untouched',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {pathToFileURL,fileURLToPath}=await import('node:url');
  const path=await import('node:path');
  const dir=await mkdtemp(fileURLToPath(new URL('../.oqm-headline-test-',import.meta.url)));
  let unavailable=false,count=0;
  const saved=[];
  globalThis.__headlineDb={from(table){
    assert.equal(table,'headline_exposures');
    return {
      select(){return {
        limit:async()=>({error:unavailable ? {message:'missing table'} : null}),
        eq(){return {gte:async()=>({count,error:unavailable ? {message:'missing table'} : null})};},
      };},
      upsert:async(row,options)=>{saved.push({row,options});return {error:null};},
    };
  }};
  try {
    await writeFile(path.join(dir,'db.mjs'),'export function supabaseServer(){return globalThis.__headlineDb;}');
    await writeFile(path.join(dir,'analytics.mjs'),js);
    const source=(await readFile(new URL('../src/app/api/experiments/headline/route.ts',import.meta.url),'utf8'))
      .replace('"next/server"','"next/server.js"').replace('"@/lib/supabase"','"./db.mjs"').replace('"@/lib/conversion-analytics"','"./analytics.mjs"');
    await writeFile(path.join(dir,'route.mjs'),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
    const {GET,POST}=await import(pathToFileURL(path.join(dir,'route.mjs')));
    const req=(body,headers={})=>new Request('https://www.openqualitymethod.com/api/experiments/headline',{
      method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    unavailable=true;assert.equal((await GET()).status,503);
    assert.equal((await POST(req(assignment))).status,503);
    unavailable=false;assert.equal((await GET()).status,204);
    assert.equal((await POST(req({...assignment,variant:10}))).status,400);
    assert.equal((await POST(req(assignment,{origin:'https://other.example'}))).status,403);
    assert.equal((await POST(req(assignment,{'content-length':'2048'}))).status,413);
    count=1000;assert.equal((await POST(req(assignment))).status,429);
    count=0;
    assert.equal((await POST(req({...assignment,filename:'secret.mov'},{'x-forwarded-for':'192.0.2.1'}))).status,204);
    assert.equal(saved.length,1);
    assert.deepEqual(saved[0].options,{onConflict:'experiment,visitor',ignoreDuplicates:true});
    assert.doesNotMatch(JSON.stringify(saved),/secret|192\.0\.2\.1/);
  } finally {delete globalThis.__headlineDb;await rm(dir,{recursive:true,force:true});}
});
