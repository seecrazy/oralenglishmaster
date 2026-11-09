#!/usr/bin/env node
/**
 * 从 audio/ 目录自动生成 index.html 中的 audioManifest 清单：node tools/gen-manifest.js
 * 新增/删除音频文件后运行一次即可，无需手工维护清单。
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const indexPath = path.join(root, "index.html");
const html = fs.readFileSync(indexPath, "utf8");

const chapters = fs.readdirSync(path.join(root, "audio"))
  .filter(d => fs.statSync(path.join(root, "audio", d)).isDirectory())
  .sort();

const groups = chapters.map(chapter => {
  const ids = fs.readdirSync(path.join(root, "audio", chapter))
    .filter(f => f.endsWith(".mp3"))
    .map(f => f.replace(/\.mp3$/, ""))
    .sort();
  const lines = [];
  for (let i = 0; i < ids.length; i += 6) {
    lines.push("      " + ids.slice(i, i + 6).map(id => `"${chapter}/${id}"`).join(",") + ",");
  }
  return lines.join("\n");
});

const generated = "    const audioManifest = new Set([\n" + groups.join("\n\n") + "\n    ]);";

const current = html.match(/    const audioManifest = new Set\(\[[\s\S]*?\]\);/);
if (!current) {
  console.error("✗ index.html 中找不到 audioManifest 块");
  process.exit(1);
}

if (current[0] === generated) {
  console.log(`✓ 清单已是最新（${chapters.length} 章）`);
  process.exit(0);
}

fs.writeFileSync(indexPath, html.replace(current[0], generated));
const count = groups.join("\n").match(/"/g).length / 2;
console.log(`✓ 已重写清单：${chapters.length} 章 / ${count} 条音频`);
