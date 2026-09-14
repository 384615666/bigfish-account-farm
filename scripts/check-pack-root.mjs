// electron-builder 打包前会遍历项目根目录并对每个条目 lstat；
// 文件名一旦在 UTF-16 ↔ ANSI 转换中损坏（本目录出现过被 Windows 输入法工具
// 写坏的 *user.config），lstat 会直接 ENOENT，报错是一句没头没尾的
// "no such file or directory, lstat '...'". 这里提前把问题说清楚。
import { readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "dist-renderer", "release", "artifacts"]);

const broken = [];
for (const name of readdirSync(ROOT)) {
  if (SKIP.has(name)) continue;
  try {
    lstatSync(path.join(ROOT, name));
  } catch (e) {
    const hex = [...name].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
    broken.push({ name, hex, code: e.code });
  }
}

if (broken.length) {
  console.error("打包中止：项目根目录有文件名已损坏的条目，electron-builder 无法读取。\n");
  for (const b of broken) console.error(`  ${JSON.stringify(b.name)}  (${b.code})  码位: ${b.hex}`);
  console.error(
    [
      "\n这些通常是被 Windows 输入法/输入法内核写坏的文件名（本目录出现过 3 个 *user.config）。",
      "处理办法：把它们移出项目根目录（内容原样保留），例如：",
      '  mkdir ..\\_junk-quarantine',
      '  Move-Item -LiteralPath "<上面的名字>" ..\\_junk-quarantine\\',
      "然后重新执行 npm run dist。",
    ].join("\n")
  );
  process.exit(1);
}

console.log("打包前检查通过：根目录所有条目均可读。");
