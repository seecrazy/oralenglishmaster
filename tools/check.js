#!/usr/bin/env node
/**
 * 数据完整性校验：node tools/check.js
 *
 * 检查项：
 *  1. audioManifest 清单与 audio/ 目录下的 MP3 文件一一对应
 *  2. 每个章节的每段对话（chapterDialogues）里的台词 id 在章节内不重复
 *  3. 每句台词都有对应的 audio/<chapter>/<id>.mp3 且在清单中
 *  4. 对话里引用的 role 都在 roles 中有定义
 *  5. 测验题的 answer 索引不越界
 *  6. chapters 里声明的章节都有 chapterDialogues（没有走 fallback 的章节）
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

let failures = 0;
function fail(msg) {
  failures++;
  console.error("  ✗ " + msg);
}
function ok(msg) {
  console.log("  ✓ " + msg);
}

// ---- 1. 清单 vs 磁盘 ----
console.log("[1] audioManifest 清单 vs audio/ 目录");
const manifestMatch = html.match(/const audioManifest = new Set\(\[([\s\S]*?)\]\);/);
if (!manifestMatch) {
  fail("找不到 audioManifest 定义");
} else {
  const manifest = new Set([...manifestMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
  const disk = new Set();
  for (const dir of fs.readdirSync(path.join(root, "audio"))) {
    for (const f of fs.readdirSync(path.join(root, "audio", dir))) {
      if (f.endsWith(".mp3")) disk.add(dir + "/" + f.replace(/\.mp3$/, ""));
    }
  }
  const noDisk = [...manifest].filter(k => !disk.has(k));
  const noManifest = [...disk].filter(k => !manifest.has(k));
  noDisk.length ? fail(`清单有但磁盘没有 (${noDisk.length}): ${noDisk.slice(0, 5).join(", ")}`)
    : ok(`清单 ${manifest.size} 条全部存在于磁盘`);
  noManifest.length ? fail(`磁盘有但清单没有 (${noManifest.length}): ${noManifest.slice(0, 5).join(", ")}`)
    : ok(`磁盘 ${disk.size} 个文件全部在清单中`);
}

// ---- 解析场景数组 ----
const sceneArrays = {};
for (const m of html.matchAll(/const (\w*SceneLines\w*) = \[([\s\S]*?)\n\s*\];/g)) {
  sceneArrays[m[1]] = {
    ids: [...m[2].matchAll(/id:\s*"([a-z]+\d+)"/g)].map(x => x[1]),
    roles: [...m[2].matchAll(/role:\s*"(\w+)"/g)].map(x => x[1])
  };
}

// ---- 解析 chapters 与 chapterDialogues ----
const chaptersBlock = html.slice(
  html.indexOf("const chapters = {"),
  html.indexOf("let activeChapterId")
);
const chapterKeys = [...chaptersBlock.matchAll(/^ {6}(\w+): \{$/gm)].map(m => m[1]);

const dialoguesBlock = html.slice(
  html.indexOf("const chapterDialogues = {}"),
  html.indexOf("let currentDialogues")
);
const chapterDialogues = {};
for (const m of dialoguesBlock.matchAll(/^ {2}(\w+): \[([\s\S]*?)^ {2}\],?$/gm)) {
  chapterDialogues[m[1]] = [...m[2].matchAll(/lines:\s*(\w+),?/g)].map(x => x[1]);
}

// ---- 2/3. 台词 id、音频 ----
console.log("[2] 章节对话台词 id 与音频文件");
let totalLines = 0;
const usedRoles = new Set();
for (const key of chapterKeys) {
  const arrs = chapterDialogues[key] || [];
  if (!arrs.length) {
    fail(`章节 ${key} 没有 chapterDialogues，将走 sceneLines fallback`);
    continue;
  }
  const seen = new Set();
  let chapterBad = false;
  for (const arr of arrs) {
    const data = sceneArrays[arr];
    if (!data) { fail(`章节 ${key} 引用了不存在的数组 ${arr}`); chapterBad = true; continue; }
    for (const id of data.ids) {
      if (seen.has(key + "/" + id)) { fail(`章节 ${key} 内台词 id 重复: ${id}`); chapterBad = true; }
      seen.add(key + "/" + id);
      data.roles.forEach(r => usedRoles.add(r));
    }
  }
  if (chapterBad) continue;
  totalLines += seen.size;
  const missing = [...seen].filter(k => !fs.existsSync(path.join(root, "audio", k + ".mp3")));
  missing.length ? fail(`章节 ${key} 缺音频: ${missing.join(", ")}`) : null;
}
ok(`${chapterKeys.length} 章共 ${totalLines} 句台词，章内 id 无重复`);

let missingAudioCount = 0;
for (const key of chapterKeys) {
  for (const arr of chapterDialogues[key] || []) {
    const data = sceneArrays[arr];
    if (!data) continue;
    for (const id of data.ids) {
      if (!fs.existsSync(path.join(root, "audio", key, id + ".mp3"))) missingAudioCount++;
    }
  }
}
missingAudioCount === 0 ? ok("每句台词都有对应 MP3") : fail(`${missingAudioCount} 句台词缺 MP3`);

// ---- 4. roles ----
console.log("[3] 角色 role 定义");
const rolesBlock = html.slice(html.indexOf("const roles = {"), html.indexOf("const irregularWordMap"));
const roleKeys = new Set([...rolesBlock.matchAll(/^ {6}(\w+): \{$/gm)].map(m => m[1]));
const unknownRoles = [...usedRoles].filter(r => !roleKeys.has(r));
unknownRoles.length ? fail(`对话引用了未定义的角色: ${unknownRoles.join(", ")}`)
  : ok(`${usedRoles.size} 个角色全部有定义`);

// ---- 5. 测验 answer 索引 ----
console.log("[4] 测验数据");
let quizCount = 0;
let quizBad = 0;
for (const m of html.matchAll(/const (\w*QuizData\w*) = \[([\s\S]*?)\n\s*\];/g)) {
  for (const q of m[2].matchAll(/\{ question:[\s\S]*?answer: (\d+) \}/g)) {
    quizCount++;
    const optionsCount = (q[0].match(/options: \[/) ? q[0].split("options: [")[1].split("]")[0].match(/"/g) : []).length / 2;
    if (Number(q[1]) >= optionsCount) { quizBad++; fail(`${m[1]} 有题目 answer=${q[1]} 越界（选项数 ${optionsCount}）`); }
  }
}
quizBad === 0 ? ok(`${quizCount} 道测验题 answer 索引全部合法`) : null;

// ---- 汇总 ----
console.log("");
if (failures) {
  console.error(`共 ${failures} 项未通过`);
  process.exit(1);
}
console.log("全部通过 ✓");
