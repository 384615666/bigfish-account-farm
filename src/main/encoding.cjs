"use strict";
// 文本文件编码识别：中文 Excel 导出的 CSV 常是 GBK/ANSI，或带 BOM 的 UTF-8/UTF-16。
// 依次尝试 UTF-8（严格模式）→ GBK → 宽松 UTF-8，保证中文表头/备注不乱码。

function decodeText(buf) {
  if (!buf || !buf.length) return "";
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString("utf8").replace(/^\uFEFF/, "");
  }
  // UTF-16 LE BOM（Excel「Unicode 文本」导出）
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf).replace(/^\uFEFF/, "");
  }
  // 严格 UTF-8：合法则直接用；含非法字节（常见于 GBK）则抛错走回退
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 下面回退 GBK */
  }
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return buf.toString("utf8"); // 极端兜底
  }
}

module.exports = { decodeText };
