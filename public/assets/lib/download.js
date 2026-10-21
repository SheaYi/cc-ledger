/**
 * 浏览器端文件下载（Blob → 本地文件）。
 *
 * ## 为什么要有这个模块（`import.js` 曾「点了没反应」的根因）
 *
 * 原始写法是：
 *   const url = URL.createObjectURL(blob);
 *   const a = h('<a href="..." download="x.csv"></a>');  // h() 来自 <template>.content
 *   a.click();                                          // 节点从未进入文档
 *   URL.revokeObjectURL(url);                           // 同步撤销
 *
 * 这里有**两个各自足以致命**的缺陷，而它们叠在一起时症状是「静默无反应」：
 *
 * ① **`<template>.content` 里的节点不是文档的一部分**（属于 inert template fragment，
 *    没有连接到 document）。对这样的元素调 `click()`，浏览器**不会**走下载流程。
 *    实测（CDP 探针逐变量对比，同一页面同一按钮）：
 *      · `h()` 解析出的 <a>，不入 DOM，同步 revoke → **不下载**
 *      · `createElement` 的 <a>，不入 DOM，同步 revoke → 下载成功
 *    唯一差别就是节点是否被 adopt 进文档。
 * ② **同步 `revokeObjectURL`** 掐断的是「已经开始但尚未取完」的那次读取。
 *    独立复现：`fetch(blobUrl)` 在同步 revoke 之后抛 `TypeError`；
 *    延迟 1s revoke 则返回 200。
 *
 * 两者任一被修掉就够用，但**都存在时修复者很容易只改一个**，
 * 然后在另一处（导出 CSV）再次复发 —— 这正是把它收敛成一个函数的原因。
 *
 * ## 三条铁律
 *   1. `<a>` 必须 `document.body.appendChild()` 之后再 click；
 *   2. click 之后立刻 `a.remove()`（不入 DOM 也会被 GC，但留着会污染 DOM）；
 *   3. `revokeObjectURL` 必须**异步**（`setTimeout`），否则与下载抢同一个 URL。
 *
 * ## 异常处理
 * 浏览器不提供「下载是否成功」的 API（没有 onerror / oncomplete），
 * 所以能捕获的失败只有三类：`createObjectURL` 抛错、`click()` 抛错、
 * 以及零字节内容。后者由调用方用 `throwOnEmpty` 自己判断。
 * 真正的「保存对话框被取消」用户侧无感，不该报错 —— 成功提示照给。
 */

import { toast } from '../ui.js';

/**
 * 把一段文本作为文件下载。
 *
 * @param {string} filename 带扩展名的文件名（如 `导入模板.csv`）
 * @param {string|Blob} content 文本或已构造好的 Blob
 * @param {object} [opts]
 * @param {string} [opts.mime='text/csv;charset=utf-8']
 * @param {boolean} [opts.throwOnEmpty=false] 内容为空时抛错而不是下空文件
 * @param {string}  [opts.okMessage] 成功 toast 文案；不传则不弹 toast
 * @returns {boolean} 是否成功发起了下载
 */
export function downloadTextFile(filename, content, opts = {}) {
  const { mime = 'text/csv;charset=utf-8', throwOnEmpty = false, okMessage = '' } = opts;

  let blob;
  try {
    blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    if (blob.size === 0) {
      throw new Error('要下载的文件内容为空');
    }
  } catch (err) {
    toast(`下载失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  }

  let url = null;
  let a = null;
  try {
    url = URL.createObjectURL(blob);
    a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // `rel=noopener` 对 blob 无意义，但显式清掉 target 语义：
    // 一旦将来有人加了 target="_blank"， noreferrer 能避免把 blob URL 泄给新窗口
    a.rel = 'noopener';
    // 关键①：先入文档再 click —— 见文件头
    document.body.appendChild(a);
    a.click();
    // 关键②：click 之后立刻移除
    a.remove();
  } catch (err) {
    if (a) a.remove();
    toast(`下载失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  } finally {
    if (url) {
      // 关键③：异步撤销。setTimeout 而非 requestAnimationFrame ——
      // rAF 在后台标签页里不跑，会让 URL 永远不释放（内存泄漏）。
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  if (okMessage) toast(okMessage, 'success');
  return true;
}
